import {StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {DateWaits, RESCHEDULE_PER_ROUND, type RouteStep} from '../DateWaits';
import {QueueService, workflowQueue} from '../QueueService';

const MINUTE = 60_000;
const wall = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 16);
const dateWait = (ms: number) => ({until: wall(ms), timezone: 'UTC'});
const instant = (config: {until: string}) => new Date(`${config.until}:00Z`).toISOString();

/** A step for lateRoute, connected to `to` (each `[toStepId, branch?]`) */
const step = (id: string, type: RouteStep['type'], to: [string, string?][] = [], config: object = {}): RouteStep => ({
  id,
  type,
  config: config as RouteStep['config'],
  outgoingTransitions: to.map(([toStepId, branch]) => ({toStepId, condition: branch ? {branch} : null})),
});

describe('DateWaits.lateRoute', () => {
  const never = async () => {
    throw new Error('no condition expected');
  };

  it('skips up to the next date wait, past emails, waits and webhooks', async () => {
    const steps = [
      step('w1', 'DELAY', [['e1']], dateWait(-MINUTE)),
      step('e1', 'SEND_EMAIL', [['d']]),
      step('d', 'DELAY', [['h']], {amount: 1, unit: 'days'}),
      step('h', 'WEBHOOK', [['ev']]),
      step('ev', 'WAIT_FOR_EVENT', [['w2']]),
      step('w2', 'DELAY', [['e2']], dateWait(MINUTE)),
      step('e2', 'SEND_EMAIL'),
    ];

    const {visited, end} = await DateWaits.lateRoute(steps, 'w1', never);

    expect(visited.map(visit => visit.step.id)).toEqual(['e1', 'd', 'h', 'ev']);
    expect(visited.every(visit => 'skipped' in visit)).toBe(true);
    expect(end).toEqual({dateWait: steps[5]});
  });

  it('stops at a date wait even if its configuration is broken, so that it fails there', async () => {
    const steps = [
      step('w1', 'DELAY', [['w2']], dateWait(-MINUTE)),
      step('w2', 'DELAY', [], {until: '2026-02-31T10:00', timezone: 'UTC'}),
    ];

    expect((await DateWaits.lateRoute(steps, 'w1', never)).end).toEqual({dateWait: steps[1]});
  });

  it('evaluates a condition and follows its branch, and stops at an Exit', async () => {
    const steps = [
      step('w1', 'DELAY', [['c']], dateWait(-MINUTE)),
      step('c', 'CONDITION', [
        ['yes1', 'yes'],
        ['no1', 'no'],
      ]),
      step('yes1', 'SEND_EMAIL', [['x']]),
      step('x', 'EXIT'),
      step('no1', 'SEND_EMAIL'),
    ];
    const branchOf = vi.fn(async () => ({branch: 'yes', result: true}));

    const {visited, end} = await DateWaits.lateRoute(steps, 'w1', branchOf);

    expect(branchOf).toHaveBeenCalledWith(steps[1]);
    expect(visited).toEqual([
      {step: steps[1], condition: {branch: 'yes', result: true}},
      {step: steps[2], skipped: true},
    ]);
    expect(end).toEqual({exit: steps[3]});
  });

  it('ends at a condition whose branch leads nowhere, with that branch', async () => {
    const steps = [
      step('w1', 'DELAY', [['c']], dateWait(-MINUTE)),
      step('c', 'CONDITION', [['yes1', 'yes']]),
      step('yes1', 'SEND_EMAIL'),
    ];

    const {end} = await DateWaits.lateRoute(steps, 'w1', async () => ({branch: 'no'}));

    expect(end).toEqual({end: true, lastStep: steps[1], branch: 'no'});
  });

  it('ends after the last step when no date wait is left, or at the wait itself with nothing after it', async () => {
    const steps = [step('w1', 'DELAY', [['e1']], dateWait(-MINUTE)), step('e1', 'SEND_EMAIL')];

    expect((await DateWaits.lateRoute(steps, 'w1', never)).end).toEqual({end: true, lastStep: steps[1], branch: null});
    const alone = step('w1', 'DELAY', [], dateWait(-MINUTE));
    expect((await DateWaits.lateRoute([alone], 'w1', never)).end).toEqual({end: true, lastStep: alone, branch: null});
  });

  it('goes past a skipped wait for an event by its timeout branch, if it has one', async () => {
    const steps = [
      step('w1', 'DELAY', [['ev']], dateWait(-MINUTE)),
      step('ev', 'WAIT_FOR_EVENT', [['late', 'timeout']]),
      step('late', 'SEND_EMAIL'),
    ];

    expect((await DateWaits.lateRoute(steps, 'w1', never)).end).toEqual({end: true, lastStep: steps[2], branch: null});
  });

  it('throws on a step missing from the workflow', async () => {
    await expect(DateWaits.lateRoute([step('w1', 'DELAY', [['gone']])], 'w1', never)).rejects.toThrow(/not in/);
  });
});

/** Moving the contacts waiting at a date wait to its new date, through the real queue */
describe('DateWaits.rescheduleRound', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let workflowId: string;
  let stepId: string;

  beforeEach(async () => {
    await workflowQueue.obliterate({force: true});
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    const workflow = await factories.createWorkflow({projectId, enabled: true});
    workflowId = workflow.id;
    stepId = (
      await factories.createWorkflowStep({workflowId, type: WorkflowStepType.DELAY, config: dateWait(60 * MINUTE)})
    ).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `count` runs waiting at the step since an hour ago's date, with their delay's end queued */
  async function waiting(count: number, {queued = true, output}: {queued?: boolean; output?: object} = {}) {
    const contacts = await factories.createContacts(projectId, count);
    const runs = [];
    for (const contact of contacts) {
      const execution = await prisma.workflowExecution.create({
        data: {workflowId, contactId: contact.id, status: WorkflowExecutionStatus.WAITING, currentStepId: stepId},
      });
      const old = dateWait(60 * MINUTE);
      const row = await prisma.workflowStepExecution.create({
        data: {
          executionId: execution.id,
          stepId,
          status: StepExecutionStatus.COMPLETED,
          output: output ?? {...old, at: instant(old), resumeAt: instant(old)},
        },
      });
      if (queued) {
        await QueueService.queueWorkflowDelayEnd(execution.id, stepId, row.id, 60 * MINUTE);
      }
      runs.push({executionId: execution.id, rowId: row.id});
    }
    return runs;
  }

  const job = (rowId: string) => workflowQueue.getJob(`workflow-delay-end-${rowId}`);
  const dueIn = async (rowId: string) => {
    const queued = (await job(rowId))!;
    return queued.timestamp + queued.delay - Date.now();
  };
  const setDate = (ms: number) => {
    const config = dateWait(ms);
    return prisma.workflowStep.update({where: {id: stepId}, data: {config}}).then(() => config);
  };
  const round = (after?: string) =>
    DateWaits.rescheduleRound({type: 'reschedule-date-wait', stepId, passId: 'p', after});

  it('moves the job and the stored date of a contact waiting, to a later and to an earlier date', async () => {
    const [run] = await waiting(1);

    const later = await setDate(120 * MINUTE);
    await round();
    expect(await dueIn(run!.rowId)).toBeGreaterThan(118 * MINUTE);
    expect((await prisma.workflowStepExecution.findUniqueOrThrow({where: {id: run!.rowId}})).output).toMatchObject({
      at: instant(later),
      resumeAt: instant(later),
    });

    await setDate(20 * MINUTE);
    await round();
    expect(await dueIn(run!.rowId)).toBeLessThan(20 * MINUTE);
  });

  it('ends right away the wait of a date now past', async () => {
    const [run] = await waiting(1);

    await setDate(-10 * MINUTE);
    await round();

    expect(await dueIn(run!.rowId)).toBeLessThanOrEqual(0);
  });

  it('queues the job again when it was lost', async () => {
    const [run] = await waiting(1, {queued: false});

    await setDate(30 * MINUTE);
    await round();

    expect(await (await job(run!.rowId))!.getState()).toBe('delayed');
    expect(await dueIn(run!.rowId)).toBeLessThan(30 * MINUTE);
  });

  it('leaves to the next try a run whose job is running, since it may hold itself back to the old date', async () => {
    const [run] = await waiting(1);
    const queued = (await job(run!.rowId))!;
    vi.spyOn(queued, 'getState').mockResolvedValue('active');
    vi.spyOn(workflowQueue, 'getJob').mockResolvedValue(queued);

    await setDate(10 * MINUTE);
    await expect(round()).rejects.toThrow(/could not be moved/);
    vi.mocked(workflowQueue.getJob).mockRestore();

    expect((await prisma.workflowStepExecution.findUniqueOrThrow({where: {id: run!.rowId}})).output).not.toMatchObject({
      at: instant(dateWait(10 * MINUTE)),
    });
  });

  it('leaves a run whose wait was for a duration', async () => {
    const [run] = await waiting(1, {
      output: {delayAmount: 1, delayUnit: 'hours', resumeAt: instant(dateWait(60 * MINUTE))},
    });

    await setDate(10 * MINUTE);
    await round();

    expect(await dueIn(run!.rowId)).toBeGreaterThan(58 * MINUTE);
  });

  it('leaves a run to the next try when its job cannot be moved, and fixes it then', async () => {
    const [run] = await waiting(1);
    const target = await setDate(10 * MINUTE);
    vi.spyOn(QueueService, 'rescheduleWorkflowDelayEnd').mockRejectedValueOnce(new Error('Redis down'));

    await expect(round()).rejects.toThrow(/could not be moved/);
    expect((await prisma.workflowStepExecution.findUniqueOrThrow({where: {id: run!.rowId}})).output).not.toMatchObject({
      at: instant(target),
    });

    await round();
    expect(await dueIn(run!.rowId)).toBeLessThan(10 * MINUTE);
  });

  it('goes in rounds, the next one queued after the last run', async () => {
    const runs = await waiting(RESCHEDULE_PER_ROUND + 1, {queued: false});
    const next = vi.spyOn(QueueService, 'queueDateWaitReschedule');
    await setDate(10 * MINUTE);

    await round();

    const lastOfRound = [...runs].map(run => run.executionId).sort()[RESCHEDULE_PER_ROUND - 1];
    expect(next).toHaveBeenCalledWith({type: 'reschedule-date-wait', stepId, passId: 'p', after: lastOfRound});
    const moved = await prisma.workflowStepExecution.count({
      where: {stepId, output: {path: ['at'], equals: instant(dateWait(10 * MINUTE))}},
    });
    expect(moved).toBe(RESCHEDULE_PER_ROUND);

    await round(lastOfRound);
    expect(next).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('does nothing once the step is gone or no longer waits until a date', async () => {
    await waiting(1, {queued: false});
    const reschedule = vi.spyOn(QueueService, 'rescheduleWorkflowDelayEnd');

    await prisma.workflowStep.update({where: {id: stepId}, data: {config: {amount: 1, unit: 'hours'}}});
    await round();
    await prisma.workflowStep.delete({where: {id: stepId}});
    await round();

    expect(reschedule).not.toHaveBeenCalled();
  });

  it('queues two rounds for each change of date', async () => {
    const queue = vi.spyOn(QueueService, 'queueDateWaitReschedule');

    await DateWaits.queueReschedule(stepId);

    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue.mock.calls[1]![1]).toBe(2 * MINUTE);
    expect(queue.mock.calls[0]![0].passId).not.toBe(queue.mock.calls[1]![0].passId);
  });
});

describe('DateWaits.stepWaits', () => {
  const prisma = getPrismaClient();

  it('counts the contacts waiting at each step, and says when each date wait ends', async () => {
    const {project} = await factories.createUserWithProject();
    const workflow = await factories.createWorkflow({projectId: project.id});
    const past = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.DELAY,
      config: dateWait(-60 * MINUTE),
    });
    const ahead = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.DELAY,
      config: dateWait(60 * MINUTE),
    });
    const event = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.WAIT_FOR_EVENT,
      config: {eventName: 'x'},
    });
    const email = await factories.createWorkflowStep({workflowId: workflow.id, type: WorkflowStepType.SEND_EMAIL});
    for (const [stepId, status] of [
      [ahead.id, WorkflowExecutionStatus.WAITING],
      [ahead.id, WorkflowExecutionStatus.WAITING],
      [event.id, WorkflowExecutionStatus.WAITING],
      [email.id, WorkflowExecutionStatus.RUNNING],
    ] as const) {
      const contact = await factories.createContact({projectId: project.id});
      await prisma.workflowExecution.create({
        data: {workflowId: workflow.id, contactId: contact.id, status, currentStepId: stepId},
      });
    }

    const waits = await DateWaits.stepWaits(workflow.id, [past, ahead, event, email]);

    expect(waits).toEqual([
      {stepId: past.id, waiting: 0, at: instant(past.config as {until: string}), late: true},
      {stepId: ahead.id, waiting: 2, at: instant(ahead.config as {until: string}), late: false},
      {stepId: event.id, waiting: 1},
    ]);
  });
});
