import {StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {redis} from '../../database/redis';
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
/** Where a run waits now, and where that leads now, as a round would pick it */
const parkedAt = async (executionId: string) => {
  const row = await parkedRow(executionId);
  const step =
    row && (await prisma.workflowStep.findUnique({where: {id: row.stepId}, include: {outgoingTransitions: true}}));
  return {
    stepId: row?.stepId ?? 'none',
    branch: row?.branch ?? null,
    toStepId: (step && ParkedRuns.routeFrom(step, row.branch).toStepId) ?? 'none',
  };
};
/** A round of a press, its press marked as the one under way (as pressing does) */
const pressed = async <T extends {workflowId: string; pressId: string}>(data: T) => {
  await redis.set(`plunk-lite:continue-parked:${data.workflowId}`, data.pressId);
  return data;
};
/** The job a round queues for a run, picked where it waits now */
const continueRun = async (executionId: string) =>
  WorkflowExecutionService.continueParked(executionId, await parkedAt(executionId));
/** The round a press queued */
const pressedRound = () => vi.mocked(QueueService.queueContinueParkedRound).mock.calls[0]![0];
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

      expect(round.targets).toEqual([{stepId: first, branch: null, toStepId: second}]);
      await ParkedRuns.continueRound(round);
      expect(QueueService.queueContinueParked).toHaveBeenCalledWith(
        [{executionId, stepId: first, branch: null, toStepId: second}],
        round.pressId,
      );

      await continueRun(executionId);

      expect(await emails(executionId)).toBe(2);
      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
      expect(await parkedRow(executionId)).toMatchObject({stepId: second, branch: null});
    });

    it('follows the branch the condition took', async () => {
      const workflow = await createWorkflow();
      const condition = await workflow.add(workflow.triggerId, WorkflowStepType.CONDITION, {config: CONDITION});
      const executionId = await workflow.start();

      // Only the other branch: nothing for it to continue into
      await workflow.add(condition, SEND, {branch: 'yes'});
      let [group] = await ParkedRuns.summary(workflow.id, (await WorkflowService.get(projectId, workflow.id)).steps);
      expect(group).toMatchObject({
        stepId: condition,
        branch: 'no',
        branchName: 'No',
        count: 1,
        canContinue: false,
        branchExists: true,
      });

      const no = await workflow.add(condition, SEND, {branch: 'no'});
      [group] = await ParkedRuns.summary(workflow.id, (await WorkflowService.get(projectId, workflow.id)).steps);
      expect(group).toMatchObject({canContinue: true});

      await continueRun(executionId);

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

      await continueRun(executionId);

      expect(await emails(executionId)).toBe(1);
    });

    it('parks the run again when there is still nothing to continue into', async () => {
      const workflow = await createWorkflow();
      const email = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();

      await continueRun(executionId);

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

      const at = await parkedAt(executionId);
      await Promise.all([
        WorkflowExecutionService.continueParked(executionId, at),
        WorkflowExecutionService.continueParked(executionId, at),
      ]);
      // A job for a press made before it moved on: it waits elsewhere now
      await WorkflowExecutionService.continueParked(executionId, at);

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
      await continueRun(executionId);
      expect(await parkedRow(executionId)).toMatchObject({stepId: first});

      await prisma.workflow.update({where: {id: workflow.id}, data: {enabled: true}});
      await prisma.project.update({where: {id: projectId}, data: {disabled: true}});
      await continueRun(executionId);
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

      await continueRun(executionId);

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

      await continueRun(executionId);

      expect(QueueService.queueEmail).toHaveBeenCalledTimes(1);
      expect(await parkedRow(executionId)).toMatchObject({stepId: second});
      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
    });

    it('goes in rounds, and stops once the workflow is off', async () => {
      const workflow = await createWorkflow();
      const email = await workflow.add(workflow.triggerId, SEND);
      const next = await workflow.add(email, SEND);
      const count = CONTINUE_PER_ROUND + 1;
      const ids = Array.from({length: count}, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      await prisma.workflowExecution.createMany({
        data: ids.map(id => ({id, workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.COMPLETED})),
      });
      await prisma.plunkLiteParkedRun.createMany({
        data: ids.map(executionId => ({executionId, workflowId: workflow.id, projectId, contactId, stepId: email})),
      });
      const data = await pressed({
        type: 'continue-parked-round' as const,
        projectId,
        workflowId: workflow.id,
        targets: [{stepId: email, branch: null, toStepId: next}],
        pressId: 'p',
        round: 0,
      });
      const picked = (executionId: string) => ({executionId, stepId: email, branch: null, toStepId: next});

      await ParkedRuns.continueRound(data);

      expect(vi.mocked(QueueService.queueContinueParked).mock.calls[0]![0]).toEqual(
        ids.slice(0, CONTINUE_PER_ROUND).map(picked),
      );
      const queued = vi.mocked(QueueService.queueContinueParkedRound).mock.calls[0]!;
      expect(queued).toEqual([{...data, round: 1, after: ids[CONTINUE_PER_ROUND - 1]}, CONTINUE_ROUND_INTERVAL_MS]);

      await ParkedRuns.continueRound(queued[0]);
      expect(vi.mocked(QueueService.queueContinueParked).mock.calls[1]![0]).toEqual([picked(ids[CONTINUE_PER_ROUND]!)]);
      expect(QueueService.queueContinueParkedRound).toHaveBeenCalledTimes(1);

      await prisma.workflow.update({where: {id: workflow.id}, data: {enabled: false}});
      await ParkedRuns.continueRound(await pressed(data));
      expect(QueueService.queueContinueParked).toHaveBeenCalledTimes(2);
    });

    it('ignores, and cleans up, the rows of a deleted contact', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();
      const second = await workflow.add(first, SEND);
      await prisma.contact.delete({where: {id: contactId}});

      expect(await ParkedRuns.summary(workflow.id, (await WorkflowService.get(projectId, workflow.id)).steps)).toEqual(
        [],
      );
      await ParkedRuns.continueRound(
        await pressed({
          type: 'continue-parked-round',
          projectId,
          workflowId: workflow.id,
          targets: [{stepId: first, branch: null, toStepId: second}],
          pressId: 'p',
          round: 0,
        }),
      );

      expect(await parkedRow(executionId)).toBeNull();
      expect(QueueService.queueContinueParked).not.toHaveBeenCalled();
    });

    it('only takes them where the press found they could go', async () => {
      const workflow = await createWorkflow();
      const condition = await workflow.add(workflow.triggerId, WorkflowStepType.CONDITION, {config: CONDITION});
      const yes = await workflow.add(condition, SEND, {branch: 'yes'});
      const no = await workflow.add(condition, SEND, {branch: 'no'});
      const executionId = await workflow.start();
      expect(await parkedRow(executionId)).toMatchObject({stepId: no});
      const after = await workflow.add(no, SEND);
      await ParkedRuns.queueContinue(projectId, workflow.id);
      const round = pressedRound();
      expect(round.targets).toEqual([{stepId: no, branch: null, toStepId: after}]);

      // A target that leads elsewhere now is dropped
      await ParkedRuns.continueRound({...round, targets: [{stepId: yes, branch: null, toStepId: after}]});
      expect(QueueService.queueContinueParked).not.toHaveBeenCalled();

      // A step on their way that is not ready stops the press
      await workflow.add(after, SEND, {noTemplate: true});
      await ParkedRuns.continueRound(await pressed(round));
      expect(QueueService.queueContinueParked).not.toHaveBeenCalled();
      expect(await parkedRow(executionId)).toMatchObject({stepId: no});
    });

    it('refuses to continue into a step further on that is not configured yet', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      await workflow.start();
      const delay = await workflow.add(first, WorkflowStepType.DELAY, {config: {amount: 1, unit: 'hours'}});
      await workflow.add(delay, SEND, {noTemplate: true});

      await expect(ParkedRuns.queueContinue(projectId, workflow.id)).rejects.toMatchObject({code: 422});
    });

    it('continues from a wait for an event that timed out', async () => {
      const workflow = await createWorkflow();
      const wait = await workflow.add(workflow.triggerId, WorkflowStepType.WAIT_FOR_EVENT, {
        config: {eventName: 'test.event', timeout: 3600},
      });
      const executionId = await workflow.start();
      const stepExecution = await prisma.workflowStepExecution.findFirstOrThrow({
        where: {executionId, stepId: wait, status: StepExecutionStatus.WAITING},
      });
      await WorkflowExecutionService.processTimeout(executionId, wait, stepExecution.id);
      const email = await workflow.add(wait, SEND);

      await continueRun(executionId);

      expect(await emails(executionId)).toBe(1);
      expect(await parkedRow(executionId)).toMatchObject({stepId: email});
    });

    it('waits at the step before one deleted while it was being parked', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      const second = await workflow.add(first, SEND);
      const executionId = await workflow.start();
      expect(await parkedRow(executionId)).toMatchObject({stepId: second});
      // Deleted without the service, as a delete that ran while the run was being parked
      await prisma.workflowStep.delete({where: {id: second}});
      const steps = async () => (await WorkflowService.get(projectId, workflow.id)).steps;
      expect((await ParkedRuns.summary(workflow.id, await steps()))[0]).toMatchObject({
        stepName: null,
        branchExists: false,
        canContinue: false,
      });

      const third = await workflow.add(first, SEND);
      await ParkedRuns.continueRound(
        await pressed({
          type: 'continue-parked-round',
          projectId,
          workflowId: workflow.id,
          targets: [{stepId: first, branch: null, toStepId: third}],
          pressId: 'p',
          round: 0,
        }),
      );

      expect(await parkedRow(executionId)).toMatchObject({stepId: first});
      expect(QueueService.queueContinueParked).toHaveBeenCalledWith(
        [{executionId, stepId: first, branch: null, toStepId: third}],
        'p',
      );
    });

    it('keeps waiting, instead of failing, when where it waits leads elsewhere by the time its job runs', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();
      const second = await workflow.add(first, SEND);
      const at = await parkedAt(executionId);
      expect(at.toStepId).toBe(second);

      // Re-routed after the round picked it: to a step not ready yet
      await prisma.workflowTransition.deleteMany({where: {fromStepId: first}});
      await workflow.add(first, SEND, {noTemplate: true});
      await WorkflowExecutionService.continueParked(executionId, at);

      expect(await runStatus(executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
      expect(await parkedRow(executionId)).toMatchObject({stepId: first});
      expect(await emails(executionId)).toBe(1);
    });

    it('pins each branch of a condition to where it went when pressed', async () => {
      const workflow = await createWorkflow();
      const condition = await workflow.add(workflow.triggerId, WorkflowStepType.CONDITION, {config: CONDITION});
      const pro = await workflow.start(
        (await factories.createContact({projectId, subscribed: true, data: {plan: 'pro'}})).id,
      );
      const free = await workflow.start();
      expect(await parkedRow(pro)).toMatchObject({stepId: condition, branch: 'yes'});
      expect(await parkedRow(free)).toMatchObject({stepId: condition, branch: 'no'});
      // A transition anyone follows out of the condition (only through the API)
      const anyone = await factories.createWorkflowStep({workflowId: workflow.id, type: SEND, templateId});
      await prisma.workflowTransition.create({data: {fromStepId: condition, toStepId: anyone.id, priority: 1}});

      await ParkedRuns.queueContinue(projectId, workflow.id);
      const round = pressedRound();
      expect(round.targets).toEqual(
        expect.arrayContaining([
          {stepId: condition, branch: 'yes', toStepId: anyone.id},
          {stepId: condition, branch: 'no', toStepId: anyone.id},
        ]),
      );

      // After the press, the yes branch gets a step of its own, ahead of the one anyone follows
      const yes = await factories.createWorkflowStep({workflowId: workflow.id, type: SEND, templateId});
      await prisma.workflowTransition.create({
        data: {fromStepId: condition, toStepId: yes.id, condition: {branch: 'yes'}, priority: 0},
      });
      await prisma.workflowTransition.updateMany({where: {toStepId: anyone.id}, data: {priority: 2}});
      await ParkedRuns.continueRound(round);

      expect(QueueService.queueContinueParked).toHaveBeenCalledWith(
        [{executionId: free, stepId: condition, branch: 'no', toStepId: anyone.id}],
        round.pressId,
      );
    });

    it('lets those on a branch the condition no longer has go on by its default', async () => {
      const workflow = await createWorkflow();
      const multi = (branches: {id: string; name: string; value: string}[]) => ({
        mode: 'multi',
        field: 'data.plan',
        branches: branches.map(b => ({...b, operator: 'equals'})),
      });
      const condition = await workflow.add(workflow.triggerId, WorkflowStepType.CONDITION, {
        config: multi([{id: 'b1', name: 'Pro', value: 'pro'}]),
      });
      const executionId = await workflow.start(
        (await factories.createContact({projectId, subscribed: true, data: {plan: 'pro'}})).id,
      );
      expect(await parkedRow(executionId)).toMatchObject({stepId: condition, branch: 'b1'});

      await prisma.workflowStep.update({
        where: {id: condition},
        data: {config: multi([{id: 'b2', name: 'Gold', value: 'gold'}])},
      });
      const fallback = await workflow.add(condition, SEND, {branch: 'default'});
      const [group] = await ParkedRuns.summary(workflow.id, (await WorkflowService.get(projectId, workflow.id)).steps);
      expect(group).toMatchObject({
        branch: 'b1',
        branchExists: false,
        fallbackBranchName: 'Default',
        canContinue: true,
      });

      await continueRun(executionId);

      expect(await emails(executionId)).toBe(1);
      expect(await parkedRow(executionId)).toMatchObject({stepId: fallback});
    });

    it('lets one press run at a time', async () => {
      const workflow = await createWorkflow();
      const first = await workflow.add(workflow.triggerId, SEND);
      await workflow.start();
      await workflow.add(first, SEND);

      await ParkedRuns.queueContinue(projectId, workflow.id);
      await expect(ParkedRuns.queueContinue(projectId, workflow.id)).rejects.toMatchObject({code: 409});

      // Once its rounds are done, pressing works again
      await ParkedRuns.continueRound(pressedRound());
      await expect(ParkedRuns.queueContinue(projectId, workflow.id)).resolves.toMatchObject({continuable: 1});
    });

    it('never leaves a contact running twice when it enters again as it is let continue', async () => {
      const workflow = await createWorkflow({allowReentry: true});
      const first = await workflow.add(workflow.triggerId, SEND);
      const executionId = await workflow.start();
      await workflow.add(first, SEND);
      const at = await parkedAt(executionId);

      const [, entry] = await Promise.all([
        WorkflowExecutionService.continueParked(executionId, at),
        WorkflowEntryService.enter({id: workflow.id, allowReentry: true}, contactId, workflow.triggerId, undefined),
      ]);

      if (entry.entered) {
        // The entry came first: the waiting run was let go, and did not continue
        expect(await emails(executionId)).toBe(1);
        expect(await parkedRow(executionId)).toBeNull();
      } else {
        // The continuing run came first, so the entry found it running
        expect(entry.refusal).toEqual({reason: 'in-progress'});
        expect(await emails(executionId)).toBe(2);
      }
    });

    it('does not park a run whose contact entered the workflow again since', async () => {
      const workflow = await createWorkflow({allowReentry: true});
      const delay = await workflow.add(workflow.triggerId, WorkflowStepType.DELAY, {
        config: {amount: 1, unit: 'hours'},
      });
      const older = await workflow.start();
      await prisma.workflowExecution.create({
        data: {
          workflowId: workflow.id,
          contactId,
          status: WorkflowExecutionStatus.WAITING,
          startedAt: new Date(Date.now() + 1000),
        },
      });

      await WorkflowExecutionService.processDelayEnd(older, delay);

      expect(await runStatus(older)).toBe(WorkflowExecutionStatus.COMPLETED);
      expect(await parkedRow(older)).toBeNull();
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
      expect(await runStatus(one)).toBe(WorkflowExecutionStatus.COMPLETED);

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
      await continueRun(executionId);
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

      // With re-entry, an earlier run still waiting on a delay and this one waiting at the end: once
      await prisma.workflowExecution.create({
        data: {
          workflowId: workflow.id,
          contactId,
          status: WorkflowExecutionStatus.WAITING,
          startedAt: new Date(Date.now() - 60_000),
        },
      });
      const again = await WorkflowService.list(projectId, 1, 20, undefined, {field: 'createdAt', direction: 'desc'});
      expect(again.data.find(w => w.id === workflow.id)).toMatchObject({contactCounts: {entered: 1, inProgress: 1}});
    });

    it('copies the switch with the workflow', async () => {
      const workflow = await createWorkflow();

      const copy = await WorkflowService.duplicate(projectId, workflow.id);

      expect(await ParkedRuns.keepsUntilExit(copy.id)).toBe(true);
    });
  });
});
