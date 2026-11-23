import type {Prisma, WorkflowStep} from '@plunk/db';
import {StepExecutionStatus, WorkflowExecutionStatus} from '@plunk/db';
import {dateWaitSpreadMs, hasDateWaitShape, isDateWait, spreadOverlap, wallTimeToInstant} from '@plunk/shared';
import type {RescheduleDateWaitJobData, StepWait} from '@plunk/types';
import {toPrismaJson} from '@plunk/types';
import {createHash, randomUUID} from 'node:crypto';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {errorMessage} from '../database/redis.js';
import {stepOutput} from '../utils/stepOutput.js';
import {pickTransition, timeoutTransition} from '../utils/workflowTransitions.js';

import {QueueService} from './QueueService.js';

/**
 * Plunk Lite: what a DELAY step that waits until a date and time ({until, timezone, ifLate}, see
 * @plunk/shared dateWait.ts) needs beyond the engine.
 *
 * - A contact that reaches one after its date with `ifLate: 'skip'` skips everything up to the next
 *   date wait (`lateRoute`): conditions are still evaluated to pick a branch, an Exit is kept.
 * - Changing the date or spread of a step moves the contacts already waiting there
 *   (`rescheduleRound`), and a delay's end that wakes up before its instant in force is held back
 *   (`heldBack`).
 * - With a spread (`spreadMinutes`), each run leaves at an instant of its own within it (`slotOf`),
 *   which every one of those reaches the same way without storing it. Being late is still measured
 *   against the date, the start of the spread: a late run with `ifLate: 'continue'` goes on at once.
 * - `stepWaits` says how many contacts wait at each step, when each date wait ends and, with a
 *   spread, when that ends and the next date wait it reaches.
 */

/** Runs moved to a new date or spread in one round */
export const RESCHEDULE_PER_ROUND = 200;
/** The second round after a change, for contacts that reached the step as it was saved */
const RESCHEDULE_AGAIN_MS = 2 * 60_000;
/** A delay's end that wakes up less than this before its date is let through */
const HOLD_BACK_MIN_MS = 1000;

type RouteTransition = {condition: Prisma.JsonValue; toStepId: string};
export type RouteStep = Pick<WorkflowStep, 'id' | 'type' | 'config'> & {outgoingTransitions?: RouteTransition[]};

/** Where a late contact's skip ends */
export type LateRouteEnd<S> =
  | {dateWait: S}
  | {exit: S}
  /** Nothing after `lastStep` (the date wait itself if nothing was walked), on `branch` */
  | {end: true; lastStep: S; branch: string | null};

/** What a late contact's skip walks through, in order */
export type LateRouteVisit<S> = {step: S; skipped: true} | {step: S; condition: Record<string, unknown>};

/** The instant a date wait's configuration stands for now and its spread, or null if it is not one */
function dateWaitOf(config: unknown): {at: Date; spreadMs: number; spreadMinutes: number} | null {
  if (!isDateWait(config)) {
    return null;
  }
  const at = wallTimeToInstant(config.until, config.timezone);
  return at ? {at, spreadMs: dateWaitSpreadMs(config), spreadMinutes: config.spreadMinutes ?? 0} : null;
}

/**
 * When a run waiting at a date wait leaves: its own instant within the spread, or the date for one
 * that reached it late (`ifLate: 'continue'`) while that date is still past
 */
function leavesAt(
  executionId: string,
  stepId: string,
  wait: {at: Date; spreadMs: number},
  output: Record<string, unknown>,
): Date {
  return typeof output.late === 'string' && wait.at.getTime() <= Date.now()
    ? wait.at
    : DateWaits.slotOf(executionId, stepId, wait.at, wait.spreadMs);
}

export const DateWaits = {
  /**
   * The instant the run `executionId` leaves the date wait `stepId`: the date plus a fraction of the
   * spread taken from a hash of both ids, so it is the same every time it is worked out, a wider
   * spread never moves anyone earlier, and the same contact is not always last. `at` without a spread
   */
  slotOf(executionId: string, stepId: string, at: Date, spreadMs: number): Date {
    if (spreadMs <= 0) {
      return at;
    }
    const share = createHash('sha256').update(`${executionId}:${stepId}`).digest().readUIntBE(0, 6) / 2 ** 48;
    return new Date(at.getTime() + Math.floor(share * spreadMs));
  },

  /**
   * The route of a contact that reached the date wait `fromStepId` late with `ifLate: 'skip'`, up to
   * the next date wait or Exit, or the end. Every other step is skipped, except a condition, which
   * `branchOf` evaluates to pick the branch to follow. Touches no database by itself.
   */
  async lateRoute<S extends RouteStep>(
    steps: readonly S[],
    fromStepId: string,
    branchOf: (condition: S) => Promise<Record<string, unknown>>,
  ): Promise<{visited: LateRouteVisit<S>[]; end: LateRouteEnd<S>}> {
    const byId = new Map(steps.map(step => [step.id, step]));
    const visited: LateRouteVisit<S>[] = [];
    const seen = new Set<string>([fromStepId]);

    let current = byId.get(fromStepId);
    if (!current) {
      throw new Error(`Step ${fromStepId} is not in the workflow`);
    }
    let result: Record<string, unknown> = {};

    for (;;) {
      const transitions = current.outgoingTransitions ?? [];
      // A skipped wait for an event goes on as when it times out (see processTimeout)
      const nextId =
        current.type === 'WAIT_FOR_EVENT'
          ? (timeoutTransition(transitions) ?? transitions[0])?.toStepId
          : pickTransition(transitions, result)?.toStepId;
      if (!nextId) {
        return {
          visited,
          end: {end: true, lastStep: current, branch: typeof result.branch === 'string' ? result.branch : null},
        };
      }
      const next = byId.get(nextId);
      if (!next) {
        throw new Error(`Step ${nextId} is not in the workflow`);
      }
      if (seen.has(next.id)) {
        throw new Error('The workflow goes round in a loop');
      }
      seen.add(next.id);

      if (next.type === 'DELAY' && hasDateWaitShape(next.config)) {
        return {visited, end: {dateWait: next}};
      }
      if (next.type === 'EXIT') {
        return {visited, end: {exit: next}};
      }
      if (next.type === 'CONDITION') {
        result = await branchOf(next);
        visited.push({step: next, condition: result});
      } else {
        result = {};
        visited.push({step: next, skipped: true});
      }
      current = next;
    }
  },

  /**
   * Record what a late contact's skip walked through, after the date wait `dateWaitStepId`: skipped
   * steps as SKIPPED, conditions as COMPLETED with their branch, each a millisecond after the one
   * before, so the run's history keeps the order it was walked in. It returns once the clock has
   * passed the last of those times, so that nothing written after (the next date wait's row, or a
   * second skip's) is dated before them: parking reads the last step done by that order.
   */
  async recordLateRoute(
    executionId: string,
    dateWaitStepId: string,
    visited: readonly LateRouteVisit<RouteStep>[],
  ): Promise<void> {
    if (visited.length === 0) {
      return;
    }
    const base = Date.now();
    await prisma.workflowStepExecution.createMany({
      data: visited.map((visit, i) => {
        const when = new Date(base + i + 1);
        return {
          executionId,
          stepId: visit.step.id,
          status: 'condition' in visit ? StepExecutionStatus.COMPLETED : StepExecutionStatus.SKIPPED,
          output: toPrismaJson('condition' in visit ? visit.condition : {skipped: 'late', dateWaitStepId}),
          startedAt: when,
          completedAt: when,
          createdAt: when,
        };
      }),
    });
    const last = base + visited.length;
    while (Date.now() <= last) {
      await new Promise(resolve => setTimeout(resolve, last + 1 - Date.now()));
    }
  },

  /** After the date of `stepId` changed: a round now and another in a while (for late arrivals) */
  async queueReschedule(stepId: string): Promise<void> {
    const passId = randomUUID();
    // Each on its own: the second still goes if the first could not be queued
    const queued = await Promise.allSettled([
      QueueService.queueDateWaitReschedule({type: 'reschedule-date-wait', stepId, passId: `${passId}-1`}),
      QueueService.queueDateWaitReschedule(
        {type: 'reschedule-date-wait', stepId, passId: `${passId}-2`},
        RESCHEDULE_AGAIN_MS,
      ),
    ]);
    const failed = queued.find(result => result.status === 'rejected');
    if (failed) {
      throw failed.reason;
    }
  },

  /**
   * One round: up to RESCHEDULE_PER_ROUND runs waiting at the date wait `stepId` whose end is not
   * their instant in force (see leavesAt) get their delay's end job moved first, and their stored
   * date after, so a failure to move the job leaves the run to the next try. An instant now past
   * ends them right away.
   * Runs whose wait started as a duration are left alone, and so are those already at the date and
   * spread in force (a stored row without `spreadMinutes` had none). Throws if any could not be
   * moved, so the job is tried again.
   */
  async rescheduleRound(data: RescheduleDateWaitJobData): Promise<void> {
    const step = await prisma.workflowStep.findUnique({where: {id: data.stepId}, select: {type: true, config: true}});
    const wait = step?.type === 'DELAY' ? dateWaitOf(step.config) : null;
    if (!wait) {
      return;
    }
    const {at, spreadMs, spreadMinutes} = wait;

    const runs = await prisma.workflowExecution.findMany({
      where: {
        status: WorkflowExecutionStatus.WAITING,
        currentStepId: data.stepId,
        ...(data.after ? {id: {gt: data.after}} : {}),
      },
      orderBy: {id: 'asc'},
      take: RESCHEDULE_PER_ROUND,
      select: {id: true},
    });
    if (runs.length === 0) {
      return;
    }

    const rows = await prisma.workflowStepExecution.findMany({
      where: {executionId: {in: runs.map(run => run.id)}, stepId: data.stepId, status: StepExecutionStatus.COMPLETED},
      orderBy: {createdAt: 'desc'},
      select: {id: true, executionId: true, output: true},
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latest.has(row.executionId)) latest.set(row.executionId, row);
    }

    const atIso = at.toISOString();
    let failed = 0;
    for (const run of runs) {
      const row = latest.get(run.id);
      const output = row ? stepOutput(row.output) : {};
      if (
        !row ||
        typeof output.until !== 'string' ||
        (output.at === atIso && (output.spreadMinutes ?? 0) === spreadMinutes)
      ) {
        continue;
      }
      const now = Date.now();
      const left = Math.max(0, leavesAt(run.id, data.stepId, {at, spreadMs}, output).getTime() - now);
      try {
        await QueueService.rescheduleWorkflowDelayEnd(run.id, data.stepId, row.id, left);
        await prisma.workflowStepExecution.update({
          where: {id: row.id},
          data: {
            output: toPrismaJson({...output, at: atIso, resumeAt: new Date(now + left).toISOString(), spreadMinutes}),
          },
        });
      } catch (error) {
        failed++;
        signale.warn(`[WORKFLOW] Could not move execution ${run.id} to its new time: ${errorMessage(error)}`);
      }
    }

    if (runs.length === RESCHEDULE_PER_ROUND) {
      await QueueService.queueDateWaitReschedule({...data, after: runs[runs.length - 1]!.id});
    }
    if (failed > 0) {
      throw new Error(`${failed} waiting contact(s) could not be moved to their new time`);
    }
  },

  /**
   * How long the delay's end of `executionId` at `stepId` still has to wait, if its wait is until a
   * date and its instant (the date and spread the step has now, see leavesAt) is more than a
   * second away; the stored end is set to it. 0 lets it end now.
   */
  async heldBack(executionId: string, stepId: string): Promise<number> {
    const row = await prisma.workflowStepExecution.findFirst({
      where: {executionId, stepId, status: StepExecutionStatus.COMPLETED},
      orderBy: {createdAt: 'desc'},
      select: {id: true, output: true, step: {select: {type: true, config: true}}},
    });
    const output = row ? stepOutput(row.output) : {};
    if (!row || typeof output.until !== 'string' || row.step.type !== 'DELAY') {
      return 0;
    }
    const wait = dateWaitOf(row.step.config);
    const slot = wait ? leavesAt(executionId, stepId, wait, output) : null;
    const left = slot ? slot.getTime() - Date.now() : 0;
    if (!wait || !slot || left <= HOLD_BACK_MIN_MS) {
      return 0;
    }
    await prisma.workflowStepExecution.update({
      where: {id: row.id},
      data: {
        output: toPrismaJson({
          ...output,
          at: wait.at.toISOString(),
          resumeAt: slot.toISOString(),
          spreadMinutes: wait.spreadMinutes,
        }),
      },
    });
    return left;
  },

  /**
   * The contacts waiting at each step of a workflow, and when each date wait ends (`late` once its
   * date has passed): an entry per step with contacts waiting, and per date wait. With a spread,
   * when it ends, and, until then, the next date wait it reaches (see spreadOverlap in @plunk/shared)
   */
  async stepWaits(workflowId: string, steps: readonly RouteStep[]): Promise<StepWait[]> {
    const groups = await prisma.workflowExecution.groupBy({
      by: ['currentStepId'],
      where: {workflowId, status: WorkflowExecutionStatus.WAITING},
      _count: {_all: true},
    });
    const waiting = new Map(groups.map(group => [group.currentStepId, group._count._all]));
    const now = Date.now();

    return steps.flatMap(step => {
      const wait = step.type === 'DELAY' ? dateWaitOf(step.config) : null;
      const count = waiting.get(step.id) ?? 0;
      if (!wait) {
        return count === 0 ? [] : [{stepId: step.id, waiting: count}];
      }
      const {at, spreadMs} = wait;
      // Once the spread is over it can no longer make anyone late
      const overlap = at.getTime() + spreadMs > now ? spreadOverlap(steps, step.id, step.config) : null;
      return [
        {
          stepId: step.id,
          waiting: count,
          at: at.toISOString(),
          late: at.getTime() <= now,
          ...(spreadMs > 0 ? {spreadUntil: new Date(at.getTime() + spreadMs).toISOString()} : {}),
          ...(overlap ? {spreadOverlap: {...overlap, at: overlap.at.toISOString()}} : {}),
        },
      ];
    });
  },
};
