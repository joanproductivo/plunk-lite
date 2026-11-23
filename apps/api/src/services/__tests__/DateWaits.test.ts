import {randomUUID} from 'node:crypto';

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

  it('follows the timeout rule of a wait for an event: its timeout or fallback branch, else its first', async () => {
    const route = (to: [string, string?][], fallback = false) => {
      const wait = step('ev', 'WAIT_FOR_EVENT', to);
      if (fallback) {
        wait.outgoingTransitions![1]!.condition = {fallback: true};
      }
      return [step('w1', 'DELAY', [['ev']], dateWait(-MINUTE)), wait, step('a', 'SEND_EMAIL'), step('b', 'SEND_EMAIL')];
    };
    const endsAt = async (steps: RouteStep[]) => {
      const {end} = await DateWaits.lateRoute(steps, 'w1', never);
      return 'lastStep' in end ? end.lastStep.id : null;
    };

    expect(await endsAt(route([['a'], ['b', 'timeout']]))).toBe('b');
    expect(await endsAt(route([['a'], ['b']], true))).toBe('b');
    expect(await endsAt(route([['a'], ['b', 'other']]))).toBe('a');
  });

  it('records the skipped steps in order, all dated before whatever is written after it returns', async () => {
    const {project} = await factories.createUserWithProject();
    const workflow = await factories.createWorkflow({projectId: project.id});
    const contact = await factories.createContact({projectId: project.id});
    const execution = await getPrismaClient().workflowExecution.create({
      data: {workflowId: workflow.id, contactId: contact.id, status: WorkflowExecutionStatus.RUNNING},
    });
    const steps = await Promise.all(
      Array.from({length: 30}, () =>
        factories.createWorkflowStep({workflowId: workflow.id, type: WorkflowStepType.SEND_EMAIL}),
      ),
    );

    await DateWaits.recordLateRoute(
      execution.id,
      'wait',
      steps.map(s => ({step: s, skipped: true as const})),
    );
    const after = Date.now();

    const rows = await getPrismaClient().workflowStepExecution.findMany({
      where: {executionId: execution.id},
      orderBy: {createdAt: 'asc'},
    });
    expect(rows.map(row => row.stepId)).toEqual(steps.map(s => s.id));
    expect(rows.every(row => row.createdAt.getTime() < after)).toBe(true);
  });

  it('throws on a step missing from the workflow', async () => {
    await expect(DateWaits.lateRoute([step('w1', 'DELAY', [['gone']])], 'w1', never)).rejects.toThrow(/not in/);
  });
});

describe('DateWaits.slotOf', () => {
  const at = new Date('2026-11-25T13:00:00Z');
  const HOUR = 60 * MINUTE;
  const ids = Array.from({length: 2000}, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  it('is the date without a spread, and the same instant every time with one', () => {
    expect(DateWaits.slotOf(ids[0]!, 's1', at, 0)).toEqual(at);
    expect(DateWaits.slotOf(ids[0]!, 's1', at, 4 * HOUR)).toEqual(DateWaits.slotOf(ids[0]!, 's1', at, 4 * HOUR));
  });

  it('spreads 2000 runs evenly over 4 hours, inside the spread', () => {
    const perHour = [0, 0, 0, 0];
    for (const id of ids) {
      const offset = DateWaits.slotOf(id, 's1', at, 4 * HOUR).getTime() - at.getTime();
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(4 * HOUR);
      perHour[Math.floor(offset / HOUR)]!++;
    }
    for (const count of perHour) {
      expect(count).toBeGreaterThanOrEqual(400);
      expect(count).toBeLessThanOrEqual(600);
    }
  });

  it('never moves anyone earlier when the spread grows, and orders each step differently', () => {
    for (const id of ids.slice(0, 200)) {
      const narrow = DateWaits.slotOf(id, 's1', at, 2 * HOUR).getTime();
      expect(DateWaits.slotOf(id, 's1', at, 4 * HOUR).getTime()).toBeGreaterThanOrEqual(narrow);
    }
    const last = (stepId: string) =>
      ids.reduce((a, b) => (DateWaits.slotOf(a, stepId, at, HOUR) > DateWaits.slotOf(b, stepId, at, HOUR) ? a : b));
    expect(last('s1')).not.toBe(last('s2'));
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

  it('moves the contacts waiting to their own instants when a spread is added, changed or removed', async () => {
    const runs = await waiting(3);
    const reschedule = vi.spyOn(QueueService, 'rescheduleWorkflowDelayEnd');
    const config = {...dateWait(60 * MINUTE), spreadMinutes: 120};
    await prisma.workflowStep.update({where: {id: stepId}, data: {config}});
    const at = new Date(instant(config));

    await round();
    for (const run of runs) {
      const slot = DateWaits.slotOf(run.executionId, stepId, at, 120 * MINUTE);
      expect((await prisma.workflowStepExecution.findUniqueOrThrow({where: {id: run.rowId}})).output).toMatchObject({
        at: at.toISOString(),
        resumeAt: slot.toISOString(),
        spreadMinutes: 120,
      });
      expect(Math.abs((await dueIn(run.rowId)) - (slot.getTime() - Date.now()))).toBeLessThan(2000);
    }
    expect(reschedule).toHaveBeenCalledTimes(3);

    // The second round finds them in place
    await round();
    expect(reschedule).toHaveBeenCalledTimes(3);

    await prisma.workflowStep.update({where: {id: stepId}, data: {config: {...config, spreadMinutes: 240}}});
    await round();
    expect(reschedule).toHaveBeenCalledTimes(6);

    await prisma.workflowStep.update({where: {id: stepId}, data: {config: dateWait(60 * MINUTE)}});
    await round();
    expect(reschedule).toHaveBeenCalledTimes(9);
    const output = (await prisma.workflowStepExecution.findUniqueOrThrow({where: {id: runs[0]!.rowId}})).output;
    expect(output).toMatchObject({resumeAt: at.toISOString(), spreadMinutes: 0});
  });

  it('leaves the runs stored before spreads existed, at the date in force with none', async () => {
    await waiting(2);
    const reschedule = vi.spyOn(QueueService, 'rescheduleWorkflowDelayEnd');

    await round();

    expect(reschedule).not.toHaveBeenCalled();
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
  it('says when a spread ends, and the next date wait it reaches', async () => {
    const spread = {...dateWait(60 * MINUTE), spreadMinutes: 120};
    const steps = [
      step('w1', 'DELAY', [['w2']], spread),
      step('w2', 'DELAY', [['w3']], dateWait(150 * MINUTE)),
      step('w3', 'DELAY', [], {...dateWait(24 * 60 * MINUTE), spreadMinutes: 60}),
    ];

    const waits = await DateWaits.stepWaits(randomUUID(), steps);

    expect(waits[0]).toEqual({
      stepId: 'w1',
      waiting: 0,
      at: instant(spread),
      late: false,
      spreadUntil: new Date(new Date(instant(spread)).getTime() + 120 * MINUTE).toISOString(),
      spreadOverlap: {stepId: 'w2', at: instant(steps[1]!.config as {until: string}), severity: 'error'},
    });
    expect(waits[1]).not.toHaveProperty('spreadUntil');
    expect(waits[2]).toMatchObject({stepId: 'w3', spreadUntil: expect.any(String)});
    expect(waits[2]).not.toHaveProperty('spreadOverlap');
  });

  it('no longer gives the overlap of a spread that is over', async () => {
    const steps = [
      step('w1', 'DELAY', [['w2']], {...dateWait(-300 * MINUTE), spreadMinutes: 120}),
      step('w2', 'DELAY', [], dateWait(-120 * MINUTE)),
    ];

    const [first] = await DateWaits.stepWaits(randomUUID(), steps);

    expect(first).toMatchObject({stepId: 'w1', late: true, spreadUntil: expect.any(String)});
    expect(first).not.toHaveProperty('spreadOverlap');
  });
});
