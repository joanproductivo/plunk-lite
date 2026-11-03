import {StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {CONTINUE_PER_ROUND, CONTINUE_ROUND_INTERVAL_MS, ParkedRuns} from '../ParkedRuns';
import {QueueService} from '../QueueService';
import {WorkflowEntryService} from '../WorkflowEntryService';
import {WorkflowExecutionService} from '../WorkflowExecutionService';
import {WorkflowService} from '../WorkflowService';

vi.mock('../QueueService', () => ({
  QueueService: {
    // Runs the queueing it is given, which here is a mock too
    queueWithoutWaiting: vi.fn(async (add: Promise<unknown>) => {
      await add.catch(() => undefined);
    }),
    queueWorkflowDelayEnd: vi.fn(async () => ({id: 'mock-delay-end-job-id'})),
    queueEmail: vi.fn(async () => ({id: 'mock-email-job-id'})),
    queueWorkflowTimeout: vi.fn(async () => ({id: 'mock-timeout-job-id'})),
    cancelWorkflowTimeout: vi.fn(async () => true),
    queueContinueParkedRound: vi.fn(async () => ({id: 'mock-round-job-id'})),
    queueContinueParked: vi.fn(async () => undefined),
  },
}));

const prisma = getPrismaClient();
let projectId: string;
let contactId: string;
let templateId: string;

const SEND = WorkflowStepType.SEND_EMAIL;

/** A workflow with its trigger, on and keeping its contacts until an Exit step unless told otherwise */
async function createWorkflow({keep = true, enabled = true, allowReentry = false} = {}) {
  const workflow = await factories.createWorkflow({projectId, enabled, allowReentry});
  const trigger = await prisma.workflowStep.findFirstOrThrow({
    where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
  });
  if (keep) {
    await ParkedRuns.setKeepUntilExit(projectId, workflow.id, true);
  }

  /** A step connected after `from` (on `branch`, for a condition) */
  const add = async (
    from: string,
    type: WorkflowStepType,
    {config, branch, noTemplate}: {config?: Record<string, unknown>; branch?: string | null; noTemplate?: boolean} = {},
  ) => {
    const step = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type,
      config: type === SEND && noTemplate ? {} : config,
      templateId: type === SEND && !noTemplate ? templateId : undefined,
    });
    await prisma.workflowTransition.create({
      data: {fromStepId: from, toStepId: step.id, condition: branch ? {branch} : undefined},
    });
    return step.id;
  };

  /** A run of the workflow for the contact, started on its trigger */
  const start = async (contact = contactId) => {
    const execution = await prisma.workflowExecution.create({
      data: {
        workflowId: workflow.id,
        contactId: contact,
        status: WorkflowExecutionStatus.RUNNING,
        currentStepId: trigger.id,
      },
    });
    await WorkflowExecutionService.processStepExecution(execution.id, trigger.id);
    return execution.id;
  };

  return {id: workflow.id, triggerId: trigger.id, add, start};
}

const parkedRow = (executionId: string) => prisma.plunkLiteParkedRun.findUnique({where: {executionId}});
const runStatus = async (executionId: string) =>
  (await prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}})).status;
const emails = (executionId: string) => prisma.email.count({where: {workflowExecutionId: executionId}});

/** A condition on a contact field, so that its branch is known: `plan` equals "pro" is yes */
const CONDITION = {field: 'data.plan', operator: 'equals', value: 'pro'};

describe('ParkedRuns - keeping contacts until an Exit step', () => {
  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, subscribed: true})).id;
    templateId = (await factories.createTemplate({projectId})).id;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('parking', () => {
    it('parks a run that reaches a step with nothing after it', async () => {
      const workflow = await createWorkflow();
      const email = await workflow.add(workflow.triggerId, SEND);

      const executionId = await workflow.start();

      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
      expect(await parkedRow(executionId)).toMatchObject({
        stepId: email,
        branch: null,
        workflowId: workflow.id,
        projectId,
      });
    });

    it('does not park in a workflow that does not keep its contacts', async () => {
      const workflow = await createWorkflow({keep: false});
      await workflow.add(workflow.triggerId, SEND);

      const executionId = await workflow.start();

      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
      expect(await parkedRow(executionId)).toBeNull();
    });

    it('does not park a run that went through an Exit step', async () => {
      const workflow = await createWorkflow();
      const email = await workflow.add(workflow.triggerId, SEND);
      await workflow.add(email, WorkflowStepType.EXIT, {config: {reason: 'done'}});

      const executionId = await workflow.start();

      const run = await prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}});
      expect(run).toMatchObject({status: WorkflowExecutionStatus.COMPLETED, exitReason: 'done'});
      expect(await parkedRow(executionId)).toBeNull();
    });

    it('parks a condition with nothing after it, and one whose branch leads nowhere, with the branch', async () => {
      const workflow = await createWorkflow();
      const condition = await workflow.add(workflow.triggerId, WorkflowStepType.CONDITION, {config: CONDITION});

      const lone = await workflow.start();
      expect(await parkedRow(lone)).toMatchObject({stepId: condition, branch: 'no'});

      await workflow.add(condition, SEND, {branch: 'yes'});
      const other = await workflow.start((await factories.createContact({projectId, subscribed: true})).id);
      expect(await parkedRow(other)).toMatchObject({stepId: condition, branch: 'no'});
      expect(await emails(other)).toBe(0);
    });

    it('parks a run whose delay ends with nothing after it', async () => {
      const workflow = await createWorkflow();
      const delay = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, {
        config: {amount: 1, unit: 'hours'},
      });
      const executionId = await workflow.start();
      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.WAITING);

      await WorkflowExecutionService.processDelayEnd(executionId, delay);

      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
      expect(await parkedRow(executionId)).toMatchObject({stepId: delay, branch: null});
    });

    it('parks a run whose wait for an event times out with nothing after it', async () => {
      const workflow = await createWorkflow();
      const wait = await workflow.add(workflow.triggerId, WorkflowStepType.WAIT_FOR_EVENT, {
        config: {eventName: 'test.event', timeout: 3600},
      });
      const executionId = await workflow.start();
      const stepExecution = await prisma.workflowStepExecution.findFirstOrThrow({
        where: {executionId, stepId: wait, status: StepExecutionStatus.WAITING},
      });

      await WorkflowExecutionService.processTimeout(executionId, wait, stepExecution.id);

      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
      expect(await parkedRow(executionId)).toMatchObject({stepId: wait, branch: null});
    });
  });

  describe('continuing', () => {
    it('lets a parked run continue into a step added after where it waits, and parks it again there', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();
      const second = await workflow.add(first, SEND);

      const result = await ParkedRuns.queueContinue(projectId, workflow.id);
      expect(result).toEqual({continuable: 1, perRound: CONTINUE_PER_ROUND, everyMinutes: 2});
      const round = vi.mocked(QueueService.queueContinueParkedRound).mock.calls[0]![0];
      expect(round).toMatchObject({type: 'continue-parked-round', workflowId: workflow.id, round: 0});

      await ParkedRuns.continueRound(round);
      expect(QueueService.queueContinueParked).toHaveBeenCalledWith([executionId], round.pressId);

      await WorkflowExecutionService.continueParked(executionId);

      expect(await emails(executionId)).toBe(2);
      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
      expect(await parkedRow(executionId)).toMatchObject({stepId: second, branch: null});
    });

    it('follows the branch the condition took, and an unconditional transition from it', async () => {
      const workflow = await createWorkflow();
      const condition = await workflow.add(workflow.triggerId, WorkflowStepType.CONDITION, {config: CONDITION});
      const executionId = await workflow.start();

      // Only the other branch: nothing for it to continue into
      await workflow.add(condition, SEND, {branch: 'yes'});
      let [group] = await ParkedRuns.summary(workflow.id, (await WorkflowService.get(projectId, workflow.id)).steps);
      expect(group).toMatchObject({stepId: condition, branch: 'no', count: 1, canContinue: false, branchExists: true});

      const no = await workflow.add(condition, SEND, {branch: 'no'});
      [group] = await ParkedRuns.summary(workflow.id, (await WorkflowService.get(projectId, workflow.id)).steps);
      expect(group).toMatchObject({canContinue: true});

      await WorkflowExecutionService.continueParked(executionId);

      expect(await emails(executionId)).toBe(1);
      expect(await parkedRow(executionId)).toMatchObject({stepId: no});
    });

    it('continues from a delay that was the last step', async () => {
      const workflow = await createWorkflow();
      const delay = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, {
        config: {amount: 1, unit: 'hours'},
      });
      const executionId = await workflow.start();
      await WorkflowExecutionService.processDelayEnd(executionId, delay);
      await workflow.add(delay, SEND);

      await WorkflowExecutionService.continueParked(executionId);

      expect(await emails(executionId)).toBe(1);
    });

    it('parks the run again when there is still nothing to continue into', async () => {
      const workflow = await createWorkflow();
      const email = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();

      await WorkflowExecutionService.continueParked(executionId);

      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
      expect(await parkedRow(executionId)).toMatchObject({stepId: email});
      expect(await emails(executionId)).toBe(1);
    });

    it('lets a run continue once, however many jobs do it', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();
      const second = await workflow.add(first, SEND);
      await workflow.add(second, WorkflowStepType.EXIT);

      await Promise.all([
        WorkflowExecutionService.continueParked(executionId),
        WorkflowExecutionService.continueParked(executionId),
      ]);
      await WorkflowExecutionService.continueParked(executionId);

      expect(await emails(executionId)).toBe(2);
      expect(await parkedRow(executionId)).toBeNull();
    });

    it('keeps them waiting while the workflow is off or the project disabled', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();
      await workflow.add(first, SEND);

      await prisma.workflow.update({where: {id: workflow.id}, data: {enabled: false}});
      await expect(ParkedRuns.queueContinue(projectId, workflow.id)).rejects.toMatchObject({code: 409});
      await WorkflowExecutionService.continueParked(executionId);
      expect(await parkedRow(executionId)).toMatchObject({stepId: first});

      await prisma.workflow.update({where: {id: workflow.id}, data: {enabled: true}});
      await prisma.project.update({where: {id: projectId}, data: {disabled: true}});
      await WorkflowExecutionService.continueParked(executionId);
      expect(await parkedRow(executionId)).toMatchObject({stepId: first});
      expect(await emails(executionId)).toBe(1);
    });

    it('refuses to continue into a step that is not configured yet', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      await workflow.start();
      await workflow.add(first, SEND, {noTemplate: true});

      await expect(ParkedRuns.queueContinue(projectId, workflow.id)).rejects.toMatchObject({code: 422});
      expect(QueueService.queueContinueParkedRound).not.toHaveBeenCalled();
    });

    it('lets go, instead of continuing, a run whose contact is in the workflow again', async () => {
      const workflow = await createWorkflow({allowReentry: true});
      const first = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();
      await workflow.add(first, SEND);
      // A newer run, started without going through the entry (which would let the parked one go)
      await prisma.workflowExecution.create({
        data: {
          workflowId: workflow.id,
          contactId,
          status: WorkflowExecutionStatus.WAITING,
          startedAt: new Date(Date.now() + 1000),
        },
      });

      await WorkflowExecutionService.continueParked(executionId);

      expect(await parkedRow(executionId)).toBeNull();
      expect(await emails(executionId)).toBe(1);
      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
    });

    it('skips a marketing email to an unsubscribed contact and carries on', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();
      const second = await workflow.add(first, SEND);
      await prisma.contact.update({where: {id: contactId}, data: {subscribed: false}});
      const [group] = await ParkedRuns.summary(workflow.id, (await WorkflowService.get(projectId, workflow.id)).steps);
      expect(group).toMatchObject({count: 1, unsubscribed: 1});

      await WorkflowExecutionService.continueParked(executionId);

      expect(QueueService.queueEmail).toHaveBeenCalledTimes(1);
      expect(await parkedRow(executionId)).toMatchObject({stepId: second});
      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
    });

    it('goes in rounds, and stops once the workflow is off', async () => {
      const workflow = await createWorkflow();
      const email = await workflow.add(workflow.triggerId, SEND);
      await workflow.add(email, SEND);
      const count = CONTINUE_PER_ROUND + 1;
      const ids = Array.from({length: count}, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      await prisma.workflowExecution.createMany({
        data: ids.map(id => ({id, workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.COMPLETED})),
      });
      await prisma.plunkLiteParkedRun.createMany({
        data: ids.map(executionId => ({executionId, workflowId: workflow.id, projectId, contactId, stepId: email})),
      });
      const data = {type: 'continue-parked-round' as const, projectId, workflowId: workflow.id, pressId: 'p', round: 0};

      await ParkedRuns.continueRound(data);

      expect(vi.mocked(QueueService.queueContinueParked).mock.calls[0]![0]).toEqual(ids.slice(0, CONTINUE_PER_ROUND));
      const next = vi.mocked(QueueService.queueContinueParkedRound).mock.calls[0]!;
      expect(next).toEqual([{...data, round: 1, after: ids[CONTINUE_PER_ROUND - 1]}, CONTINUE_ROUND_INTERVAL_MS]);

      await ParkedRuns.continueRound(next[0]);
      expect(vi.mocked(QueueService.queueContinueParked).mock.calls[1]![0]).toEqual([ids[CONTINUE_PER_ROUND]]);
      expect(QueueService.queueContinueParkedRound).toHaveBeenCalledTimes(1);

      await prisma.workflow.update({where: {id: workflow.id}, data: {enabled: false}});
      await ParkedRuns.continueRound(data);
      expect(QueueService.queueContinueParked).toHaveBeenCalledTimes(2);
    });

    it('ignores, and cleans up, the rows of a deleted contact', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();
      await workflow.add(first, SEND);
      await prisma.contact.delete({where: {id: contactId}});

      expect(await ParkedRuns.summary(workflow.id, (await WorkflowService.get(projectId, workflow.id)).steps)).toEqual(
        [],
      );
      await ParkedRuns.continueRound({
        type: 'continue-parked-round',
        projectId,
        workflowId: workflow.id,
        pressId: 'p',
        round: 0,
      });

      expect(await parkedRow(executionId)).toBeNull();
      expect(QueueService.queueContinueParked).not.toHaveBeenCalled();
    });
  });

  describe('letting go', () => {
    it('lets the waiting run go when its contact enters again', async () => {
      const workflow = await createWorkflow({allowReentry: true});
      await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();

      const entry = await WorkflowEntryService.enter(
        {id: workflow.id, allowReentry: true},
        contactId,
        workflow.triggerId,
        undefined,
      );

      expect(entry.entered).toBe(true);
      expect(await parkedRow(executionId)).toBeNull();
    });

    it('lets them go when cancelled, one or all', async () => {
      const workflow = await createWorkflow();
      await workflow.add(workflow.triggerId, SEND);
      const one = await workflow.start();
      const other = await workflow.start((await factories.createContact({projectId, subscribed: true})).id);
      const third = await workflow.start((await factories.createContact({projectId, subscribed: true})).id);

      await WorkflowService.cancelExecution(projectId, workflow.id, one);
      expect(await parkedRow(one)).toBeNull();
      expect(await runStatus(one)).toBe(WorkflowExecutionStatus.CANCELLED);

      expect(await WorkflowService.cancelAllExecutions(projectId, workflow.id)).toEqual({cancelled: 0, released: 2});
      expect(await parkedRow(other)).toBeNull();
      expect(await parkedRow(third)).toBeNull();
      expect(await runStatus(other)).toBe(WorkflowExecutionStatus.COMPLETED);
    });

    it('lets them go when the workflow stops keeping its contacts', async () => {
      const workflow = await createWorkflow();
      await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();

      await WorkflowService.update(projectId, workflow.id, {keepUntilExit: false});

      expect(await parkedRow(executionId)).toBeNull();
      expect(await ParkedRuns.keepsUntilExit(workflow.id)).toBe(false);
    });
  });

  describe('deleting steps', () => {
    it('parks the runs at a step being deleted, with what follows it, at the step before, on its branch', async () => {
      const workflow = await createWorkflow();
      const condition = await workflow.add(workflow.triggerId, WorkflowStepType.CONDITION, {config: CONDITION});
      const first = await workflow.add(condition, SEND, {branch: 'no'});
      const second = await workflow.add(first, SEND);
      const executionId = await workflow.start();
      expect(await parkedRow(executionId)).toMatchObject({stepId: second});

      await WorkflowService.deleteStep(projectId, workflow.id, first);

      expect(await parkedRow(executionId)).toMatchObject({stepId: condition, branch: 'no'});
      const added = await workflow.add(condition, SEND, {branch: 'no'});
      await WorkflowExecutionService.continueParked(executionId);
      expect(await parkedRow(executionId)).toMatchObject({stepId: added});
      expect(await emails(executionId)).toBe(3);
    });

    it('parks the runs at a last step taken out of the flow at the step before it', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      const second = await workflow.add(first, SEND);
      const executionId = await workflow.start();
      expect(await parkedRow(executionId)).toMatchObject({stepId: second});

      await WorkflowService.spliceStep(projectId, workflow.id, second);

      expect(await parkedRow(executionId)).toMatchObject({stepId: first, branch: null});
    });
  });

  describe('what the panel reads', () => {
    it('counts the waiting contacts as in progress, and marks their runs', async () => {
      const workflow = await createWorkflow();
      await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();

      const {data} = await WorkflowService.list(projectId, 1, 20, undefined, {field: 'createdAt', direction: 'desc'});
      expect(data.find(w => w.id === workflow.id)).toMatchObject({contactCounts: {entered: 1, inProgress: 1}});

      const {executions} = await WorkflowService.listExecutions(projectId, workflow.id);
      expect(executions).toEqual([expect.objectContaining({id: executionId, parked: true})]);
      expect(await WorkflowService.getExecution(projectId, workflow.id, executionId)).toMatchObject({parked: true});
    });

    it('copies the switch with the workflow', async () => {
      const workflow = await createWorkflow();

      const copy = await WorkflowService.duplicate(projectId, workflow.id);

      expect(await ParkedRuns.keepsUntilExit(copy.id)).toBe(true);
    });
  });
});
