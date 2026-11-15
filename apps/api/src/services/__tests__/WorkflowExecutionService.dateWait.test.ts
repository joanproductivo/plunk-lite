import {StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {NtfyService} from '../NtfyService';
import {ParkedRuns} from '../ParkedRuns';
import {QueueService} from '../QueueService';
import {WorkflowExecutionService} from '../WorkflowExecutionService';
import {WorkflowService} from '../WorkflowService';

vi.mock('../QueueService', () => ({
  QueueService: {
    queueWithoutWaiting: vi.fn(async (add: Promise<unknown>) => {
      await add.catch(() => undefined);
    }),
    queueWorkflowDelayEnd: vi.fn(async () => ({id: 'mock-delay-end-job-id'})),
    rescheduleWorkflowDelayEnd: vi.fn(async () => undefined),
    queueDateWaitReschedule: vi.fn(async () => ({id: 'mock-reschedule-job-id'})),
    queueEmail: vi.fn(async () => ({id: 'mock-email-job-id'})),
    queueWorkflowTimeout: vi.fn(async () => ({id: 'mock-timeout-job-id'})),
    cancelWorkflowTimeout: vi.fn(async () => true),
  },
}));

const prisma = getPrismaClient();
let projectId: string;
let contactId: string;
let templateId: string;

const MINUTE = 60_000;
/** A wall time in UTC, `ms` from now (to the minute) */
const wall = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 16);
const until = (ms: number, ifLate?: 'skip' | 'continue') => ({
  until: wall(ms),
  timezone: 'UTC',
  ...(ifLate ? {ifLate} : {}),
});

/** A workflow with its trigger; `add` connects a step after another */
async function createWorkflow() {
  const workflow = await factories.createWorkflow({projectId, enabled: true});
  const trigger = await prisma.workflowStep.findFirstOrThrow({
    where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
  });
  const add = async (from: string, type: WorkflowStepType, config?: Record<string, unknown>, branch?: string) => {
    const step = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type,
      config,
      templateId: type === WorkflowStepType.SEND_EMAIL ? templateId : undefined,
    });
    await prisma.workflowTransition.create({
      data: {fromStepId: from, toStepId: step.id, condition: branch ? {branch} : undefined},
    });
    return step.id;
  };
  const start = async () => {
    const execution = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
    });
    await WorkflowExecutionService.processStepExecution(execution.id, trigger.id);
    return execution.id;
  };
  return {id: workflow.id, triggerId: trigger.id, add, start};
}

const run = (executionId: string) => prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}});
const emails = (executionId: string) => prisma.email.count({where: {workflowExecutionId: executionId}});
const rowOf = (executionId: string, stepId: string) =>
  prisma.workflowStepExecution.findFirstOrThrow({where: {executionId, stepId}, orderBy: {createdAt: 'desc'}});

describe('WorkflowExecutionService - waiting until a date', () => {
  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, subscribed: true})).id;
    templateId = (await factories.createTemplate({projectId})).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('waits until a future date, its end queued for then', async () => {
    const workflow = await createWorkflow();
    const config = until(30 * MINUTE);
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, config);
    await workflow.add(wait, WorkflowStepType.SEND_EMAIL);

    const executionId = await workflow.start();

    expect(await run(executionId)).toMatchObject({status: WorkflowExecutionStatus.WAITING, currentStepId: wait});
    const at = new Date(`${config.until}:00Z`).toISOString();
    expect((await rowOf(executionId, wait)).output).toEqual({until: config.until, timezone: 'UTC', at, resumeAt: at});
    const [, , , delay] = vi.mocked(QueueService.queueWorkflowDelayEnd).mock.calls[0]!;
    expect(delay).toBeGreaterThan(28 * MINUTE);
    expect(delay).toBeLessThanOrEqual(30 * MINUTE);
    expect(await emails(executionId)).toBe(0);
  });

  it('ends right away a date already past with ifLate continue, and the email goes', async () => {
    const workflow = await createWorkflow();
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, until(-10 * MINUTE, 'continue'));
    await workflow.add(wait, WorkflowStepType.SEND_EMAIL);

    const executionId = await workflow.start();

    expect((await rowOf(executionId, wait)).output).toMatchObject({late: 'continue'});
    expect(vi.mocked(QueueService.queueWorkflowDelayEnd).mock.calls[0]![3]).toBe(0);
    await WorkflowExecutionService.processDelayEnd(executionId, wait);
    expect(await run(executionId)).toMatchObject({status: WorkflowExecutionStatus.COMPLETED});
    expect(await emails(executionId)).toBe(1);
  });

  it('skips the pairs whose dates have passed and waits at the first one ahead', async () => {
    const workflow = await createWorkflow();
    const waits: string[] = [];
    const sends: string[] = [];
    let from = workflow.triggerId;
    for (const ms of [-40 * MINUTE, -20 * MINUTE, -5 * MINUTE, 30 * MINUTE]) {
      const wait = await workflow.add(from, WorkflowStepType.DELAY, until(ms));
      const send = await workflow.add(wait, WorkflowStepType.SEND_EMAIL);
      waits.push(wait);
      sends.push(send);
      from = send;
    }

    const executionId = await workflow.start();

    expect(await run(executionId)).toMatchObject({status: WorkflowExecutionStatus.WAITING, currentStepId: waits[3]});
    expect(await emails(executionId)).toBe(0);
    const rows = await prisma.workflowStepExecution.findMany({where: {executionId}, orderBy: {createdAt: 'asc'}});
    expect(rows.map(row => [row.stepId, row.status])).toEqual([
      [workflow.triggerId, StepExecutionStatus.COMPLETED],
      [waits[0], StepExecutionStatus.COMPLETED],
      [sends[0], StepExecutionStatus.SKIPPED],
      [waits[1], StepExecutionStatus.COMPLETED],
      [sends[1], StepExecutionStatus.SKIPPED],
      [waits[2], StepExecutionStatus.COMPLETED],
      [sends[2], StepExecutionStatus.SKIPPED],
      [waits[3], StepExecutionStatus.COMPLETED],
    ]);
    expect(rows[2]!.output).toEqual({skipped: 'late', dateWaitStepId: waits[0]});
    expect(QueueService.queueWorkflowDelayEnd).toHaveBeenCalledTimes(1);

    // The fourth date comes (moved to now, since an end before it is held back): only its email goes
    await prisma.workflowStep.update({where: {id: waits[3]}, data: {config: until(-1 * MINUTE)}});
    await WorkflowExecutionService.processDelayEnd(executionId, waits[3]!);
    expect(await run(executionId)).toMatchObject({status: WorkflowExecutionStatus.COMPLETED});
    expect(await emails(executionId)).toBe(1);
  });

  it('evaluates a condition on the way and follows its branch, and keeps an Exit', async () => {
    const workflow = await createWorkflow();
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, until(-10 * MINUTE));
    const condition = await workflow.add(wait, WorkflowStepType.CONDITION, {
      field: 'contact.subscribed',
      operator: 'equals',
      value: true,
    });
    const yesSend = await workflow.add(condition, WorkflowStepType.SEND_EMAIL, undefined, 'yes');
    const exit = await workflow.add(yesSend, WorkflowStepType.EXIT, {reason: 'done'});
    const noSend = await workflow.add(condition, WorkflowStepType.SEND_EMAIL, undefined, 'no');

    const executionId = await workflow.start();

    // Plunk completes a run whose Exit step has nothing after it, keeping the reason
    expect(await run(executionId)).toMatchObject({status: WorkflowExecutionStatus.COMPLETED, exitReason: 'done'});
    expect(await emails(executionId)).toBe(0);
    expect(await rowOf(executionId, condition)).toMatchObject({
      status: StepExecutionStatus.COMPLETED,
      output: expect.objectContaining({branch: 'yes'}),
    });
    expect((await rowOf(executionId, yesSend)).status).toBe(StepExecutionStatus.SKIPPED);
    expect((await rowOf(executionId, exit)).status).toBe(StepExecutionStatus.COMPLETED);
    expect(await prisma.workflowStepExecution.count({where: {executionId, stepId: noSend}})).toBe(0);
  });

  it('completes the run when no date wait is left ahead, or parks it in a workflow that keeps its contacts', async () => {
    const workflow = await createWorkflow();
    await ParkedRuns.setKeepUntilExit(projectId, workflow.id, true);
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, until(-10 * MINUTE));
    const send = await workflow.add(wait, WorkflowStepType.SEND_EMAIL);

    const executionId = await workflow.start();

    expect(await run(executionId)).toMatchObject({status: WorkflowExecutionStatus.COMPLETED, currentStepId: null});
    expect(await emails(executionId)).toBe(0);
    expect(await prisma.plunkLiteParkedRun.findUnique({where: {executionId}})).toMatchObject({stepId: send});
  });

  it('keeps a run parked after a skipped step there, never before what it skipped, once that step is deleted', async () => {
    const workflow = await createWorkflow();
    await ParkedRuns.setKeepUntilExit(projectId, workflow.id, true);
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, until(-10 * MINUTE));
    const send = await workflow.add(wait, WorkflowStepType.SEND_EMAIL);
    const update = await workflow.add(send, WorkflowStepType.UPDATE_CONTACT, {updates: {seen: true}});
    const executionId = await workflow.start();
    expect(await prisma.plunkLiteParkedRun.findUnique({where: {executionId}})).toMatchObject({stepId: update});

    await WorkflowService.deleteStep(projectId, workflow.id, update);

    expect(await prisma.plunkLiteParkedRun.findUnique({where: {executionId}})).toMatchObject({stepId: send});
    expect(await emails(executionId)).toBe(0);
  });

  it('walks the skip once when two copies of the late date wait run at the same time', async () => {
    const workflow = await createWorkflow();
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, until(-10 * MINUTE));
    const send = await workflow.add(wait, WorkflowStepType.SEND_EMAIL);
    const execution = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: wait},
    });

    await Promise.all([
      WorkflowExecutionService.processStepExecution(execution.id, wait),
      WorkflowExecutionService.processStepExecution(execution.id, wait),
    ]);

    const skipped = await prisma.workflowStepExecution.findMany({where: {executionId: execution.id, stepId: send}});
    expect(skipped.map(row => row.status)).toEqual([StepExecutionStatus.SKIPPED]);
    expect(await emails(execution.id)).toBe(0);
  });

  it('fails the run with its cause when a condition on the way cannot be evaluated, sending nothing', async () => {
    const notify = vi.spyOn(NtfyService, 'notifyWorkflowExecutionFailed').mockResolvedValue(undefined as never);
    const workflow = await createWorkflow();
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, until(-10 * MINUTE));
    const condition = await workflow.add(wait, WorkflowStepType.CONDITION, {});
    await workflow.add(condition, WorkflowStepType.SEND_EMAIL, undefined, 'yes');

    const executionId = await workflow.start();

    const failed = await run(executionId);
    expect(failed).toMatchObject({status: WorkflowExecutionStatus.FAILED, currentStepId: wait});
    expect(failed.exitReason).toMatch(/Skipping past/);
    expect((await rowOf(executionId, wait)).error).toBeTruthy();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await emails(executionId)).toBe(0);
    expect(await prisma.workflowStepExecution.count({where: {executionId, stepId: condition}})).toBe(0);
  });

  it('holds back an end that comes before the date in force, and lets it through once it has come', async () => {
    const workflow = await createWorkflow();
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, until(10 * MINUTE));
    await workflow.add(wait, WorkflowStepType.SEND_EMAIL);
    const executionId = await workflow.start();

    // The date moves an hour later and the old end wakes up
    const later = until(70 * MINUTE);
    await prisma.workflowStep.update({where: {id: wait}, data: {config: later}});
    const left = await WorkflowExecutionService.processDelayEnd(executionId, wait);

    expect(left).toBeGreaterThan(68 * MINUTE);
    expect(await run(executionId)).toMatchObject({status: WorkflowExecutionStatus.WAITING});
    expect((await rowOf(executionId, wait)).output).toMatchObject({
      resumeAt: new Date(`${later.until}:00Z`).toISOString(),
    });

    await prisma.workflowStep.update({where: {id: wait}, data: {config: until(-1 * MINUTE)}});
    expect(await WorkflowExecutionService.processDelayEnd(executionId, wait)).toBe(0);
    expect(await emails(executionId)).toBe(1);
  });

  it('queues the held-back end again from an old process-step job', async () => {
    const workflow = await createWorkflow();
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, until(-1 * MINUTE, 'continue'));
    const executionId = await workflow.start();
    await prisma.workflowStep.update({where: {id: wait}, data: {config: until(60 * MINUTE)}});

    await WorkflowExecutionService.resumeLegacyStep(executionId);

    expect(await run(executionId)).toMatchObject({status: WorkflowExecutionStatus.WAITING});
    expect(QueueService.rescheduleWorkflowDelayEnd).toHaveBeenCalledWith(
      executionId,
      wait,
      (await rowOf(executionId, wait)).id,
      expect.any(Number),
    );
  });

  it('ends at its time a wait for a duration whose step became a date wait', async () => {
    const workflow = await createWorkflow();
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, {amount: 1, unit: 'hours'});
    await workflow.add(wait, WorkflowStepType.SEND_EMAIL);
    const executionId = await workflow.start();
    await prisma.workflowStep.update({where: {id: wait}, data: {config: until(300 * MINUTE)}});

    expect(await WorkflowExecutionService.processDelayEnd(executionId, wait)).toBe(0);
    expect(await emails(executionId)).toBe(1);
  });

  it('reads a configuration mixing both forms as a wait until a date', async () => {
    const workflow = await createWorkflow();
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, {
      ...until(-10 * MINUTE, 'continue'),
      amount: 1,
      unit: 'hours',
    });

    const executionId = await workflow.start().catch(() => undefined);

    // Refused as a date wait (it mixes both), so the run fails rather than waiting an hour
    const execution = await prisma.workflowExecution.findFirstOrThrow({where: {workflowId: workflow.id}});
    expect(executionId).toBeUndefined();
    expect(execution.status).toBe(WorkflowExecutionStatus.FAILED);
    expect(await prisma.workflowStepExecution.findFirst({where: {stepId: wait}})).toMatchObject({
      status: StepExecutionStatus.FAILED,
    });
  });

  it('fails without sending a date wait saved with a day that does not exist', async () => {
    vi.spyOn(NtfyService, 'notifyWorkflowExecutionFailed').mockResolvedValue(undefined as never);
    const workflow = await createWorkflow();
    const wait = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, {
      until: '2026-02-31T10:00',
      timezone: 'Europe/Madrid',
    });
    await workflow.add(wait, WorkflowStepType.SEND_EMAIL);

    const executionId = await workflow.start().catch(() => undefined);

    const execution = await prisma.workflowExecution.findFirstOrThrow({where: {workflowId: workflow.id}});
    expect(executionId).toBeUndefined();
    expect(execution.status).toBe(WorkflowExecutionStatus.FAILED);
    expect(await emails(execution.id)).toBe(0);
  });
});
