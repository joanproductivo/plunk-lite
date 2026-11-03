import type {WorkflowStep} from '@plunk/db';
import {Prisma, WorkflowExecutionStatus} from '@plunk/db';
import {WorkflowStepConfigSchemas} from '@plunk/shared';
import type {ContinueParkedRoundJobData, ContinueParkedTarget, ParkedGroup} from '@plunk/types';
import {randomUUID} from 'node:crypto';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';
import {HttpException} from '../exceptions/index.js';
import {POOL_WAIT_TRANSACTION} from '../utils/database.js';
import {lockEntry} from '../utils/workflowEntryLock.js';
import {pickTransition} from '../utils/workflowTransitions.js';

import {QueueService} from './QueueService.js';

/**
 * Plunk Lite: workflows that keep their contacts until an Exit step, as Flodesk does.
 *
 * With `keepUntilExit` on, a run that reaches the end of the workflow without an Exit step -- a step
 * with nothing after it, a condition's branch that leads nowhere, a delay or a wait for an event that
 * ends with nothing after it -- is COMPLETED as Plunk has it, and parked: a row here says at which
 * step it waits, and the branch that step took. When steps are added after that point, whoever runs
 * the workflow lets those contacts continue into them (`queueContinue`), in rounds, and each run then
 * carries on from where it waited.
 *
 * A parked row is only good while its run is still COMPLETED and its workflow still keeps its
 * contacts: every query joins both. Rows go with their workflow or project here, next to each
 * delete; a deleted contact's go lazily.
 */

/** Contacts let continue in one round, and the time between rounds */
export const CONTINUE_PER_ROUND = 200;
export const CONTINUE_ROUND_INTERVAL_MS = 2 * 60_000;

const COMPLETED = Prisma.sql`${WorkflowExecutionStatus.COMPLETED}::"WorkflowExecutionStatus"`;

/**
 * The press of "Continue" whose rounds are running for a workflow: one at a time, so that pressing
 * again does not double the pace (each round renews it; it lapses if the rounds stop unseen)
 */
const PRESS_KEY = (workflowId: string) => `plunk-lite:continue-parked:${workflowId}`;
const PRESS_TTL_SECONDS = (3 * CONTINUE_ROUND_INTERVAL_MS) / 1000;

/** Rows `p` whose workflow still keeps its contacts until an Exit step */
const KEPT = Prisma.sql`JOIN "plunk_lite_workflow_settings" ks ON ks."workflowId" = p."workflowId" AND ks."keepUntilExit"`;

export type StepWithTransitions = Pick<WorkflowStep, 'id' | 'name' | 'type' | 'config' | 'templateId'> & {
  outgoingTransitions: Array<{id: string; condition: Prisma.JsonValue; priority: number; toStepId: string}>;
};

/** A run as parking it needs it */
interface RunToPark {
  id: string;
  workflowId: string;
  contactId: string;
}

/** Where a parked run waits */
interface ParkedAt {
  stepId: string;
  branch: string | null;
}

/** The branches of a condition step now, with their names, and the one a contact matching none takes */
function conditionBranches(config: Prisma.JsonValue): {names: Map<string, string>; fallback: string} {
  const parsed = WorkflowStepConfigSchemas.condition.safeParse(config);
  if (parsed.success && 'mode' in parsed.data && parsed.data.mode === 'multi') {
    return {
      names: new Map([
        ...parsed.data.branches.map(branch => [branch.id, branch.name] as const),
        ['default', 'Default'],
      ]),
      fallback: 'default',
    };
  }
  return {
    names: new Map([
      ['yes', 'Yes'],
      ['no', 'No'],
    ]),
    fallback: 'no',
  };
}

/**
 * The branch a run parked at `step` on `branch` goes on by: its own, or -- when the condition no
 * longer has it (removed, or the condition changed between yes/no and multi-branch) -- the one a
 * contact matching none of its branches takes now
 */
function effectiveBranch(step: Pick<WorkflowStep, 'type' | 'config'>, branch: string | null): string | null {
  if (branch === null || step.type !== 'CONDITION') {
    return branch;
  }
  const {names, fallback} = conditionBranches(step.config);
  return names.has(branch) ? branch : fallback;
}

/**
 * The step a run waiting at `step` on `branch` would go to now, if any: the engine's own rule, over
 * the transitions in the engine's order (priority, then ID)
 */
function nextStepId(step: StepWithTransitions, branch: string | null): string | undefined {
  const ordered = [...step.outgoingTransitions].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const goesBy = effectiveBranch(step, branch);
  return pickTransition(ordered, goesBy ? {branch: goesBy} : {})?.toStepId;
}

/** What the engine would reject in a step's configuration, if anything */
function stepProblem(step: StepWithTransitions): string | null {
  const schemas = {
    SEND_EMAIL: WorkflowStepConfigSchemas.sendEmail,
    DELAY: WorkflowStepConfigSchemas.delay,
    WAIT_FOR_EVENT: WorkflowStepConfigSchemas.waitForEvent,
    CONDITION: WorkflowStepConfigSchemas.condition,
    WEBHOOK: WorkflowStepConfigSchemas.webhook,
    UPDATE_CONTACT: WorkflowStepConfigSchemas.updateContact,
  } as const;

  if (step.type === 'SEND_EMAIL' && !step.templateId) {
    return `"${step.name}" has no email template`;
  }
  const schema = step.type in schemas ? schemas[step.type as keyof typeof schemas] : undefined;
  if (schema && !schema.safeParse(step.config).success) {
    return `"${step.name}" is not fully configured`;
  }
  return null;
}

/** What is wrong with any step a contact let continue to `targets` could run, up to the end */
function routeProblems(steps: StepWithTransitions[], targets: ContinueParkedTarget[]): string[] {
  const byId = new Map(steps.map(step => [step.id, step]));
  const queue = targets.map(target => target.toStepId);
  const seen = new Set<string>();
  const problems = new Set<string>();

  while (queue.length > 0) {
    const step = byId.get(queue.shift()!);
    if (!step || seen.has(step.id)) {
      continue;
    }
    seen.add(step.id);
    const problem = stepProblem(step);
    if (problem) {
      problems.add(problem);
    }
    queue.push(...step.outgoingTransitions.map(t => t.toStepId));
  }

  return [...problems];
}

/** A SQL condition on parked rows `p`: waiting at one of `targets` */
function targetsWhere(targets: ContinueParkedTarget[]): Prisma.Sql {
  if (targets.length === 0) {
    return Prisma.sql`FALSE`;
  }
  const each = targets.map(t => Prisma.sql`(p."stepId" = ${t.stepId} AND p."branch" IS NOT DISTINCT FROM ${t.branch})`);
  return Prisma.sql`(${Prisma.join(each, ' OR ')})`;
}

/**
 * Park the runs of a workflow waiting at steps that are gone -- `goneStepIds`, being deleted in this
 * transaction, or (null) those no longer in the workflow -- at the last step each did that stays,
 * with the branch it took: what is connected after that step from then on reaches them. A run with
 * no such step is let go. Two statements by index, whatever the number of runs.
 */
async function parkBeforeGoneSteps(
  client: Prisma.TransactionClient,
  workflowId: string,
  goneStepIds: string[] | null,
): Promise<void> {
  const gone = (column: Prisma.Sql) =>
    goneStepIds
      ? Prisma.sql`(${column} IN (${Prisma.join(goneStepIds)}))`
      : Prisma.sql`(${column} NOT IN (SELECT ws."id" FROM "workflow_steps" ws WHERE ws."workflowId" = ${workflowId}))`;

  await client.$executeRaw`
    UPDATE "plunk_lite_parked_runs" p SET "stepId" = last."stepId", "branch" = last."branch"
    FROM (
      SELECT DISTINCT ON (se."executionId") se."executionId", se."stepId", se."output"->>'branch' AS "branch"
      FROM "plunk_lite_parked_runs" q
      JOIN "workflow_step_executions" se ON se."executionId" = q."executionId"
      JOIN "workflow_steps" s ON s."id" = se."stepId"
      WHERE q."workflowId" = ${workflowId} AND ${gone(Prisma.sql`q."stepId"`)}
        AND se."status" = 'COMPLETED' AND NOT ${gone(Prisma.sql`se."stepId"`)}
      ORDER BY se."executionId", se."completedAt" DESC NULLS LAST, se."createdAt" DESC, se."id" DESC
    ) last
    WHERE p."executionId" = last."executionId"
  `;
  await client.$executeRaw`
    DELETE FROM "plunk_lite_parked_runs" p WHERE p."workflowId" = ${workflowId} AND ${gone(Prisma.sql`p."stepId"`)}
  `;
}

/** The workflow, with its steps and transitions, as letting its contacts continue needs it */
function loadWorkflow(projectId: string, workflowId: string) {
  return prisma.workflow.findFirst({
    where: {id: workflowId, projectId},
    select: {
      enabled: true,
      project: {select: {disabled: true}},
      steps: {
        select: {
          id: true,
          name: true,
          type: true,
          config: true,
          templateId: true,
          outgoingTransitions: {select: {id: true, condition: true, priority: true, toStepId: true}},
        },
      },
    },
  });
}

export const ParkedRuns = {
  /** The step a run parked at `step` on `branch` goes to now, and the branch it goes by */
  routeFrom(step: StepWithTransitions, branch: string | null): {toStepId: string | undefined; branch: string | null} {
    return {toStepId: nextStepId(step, branch), branch: effectiveBranch(step, branch)};
  },

  /** Contacts let continue per round, and minutes between rounds, for whoever presses "Continue" */
  pace(): {perRound: number; everyMinutes: number} {
    return {perRound: CONTINUE_PER_ROUND, everyMinutes: CONTINUE_ROUND_INTERVAL_MS / 60_000};
  },

  /** Whether a workflow keeps its contacts until an Exit step */
  async keepsUntilExit(workflowId: string): Promise<boolean> {
    const row = await prisma.plunkLiteWorkflowSettings.findUnique({where: {workflowId}, select: {keepUntilExit: true}});
    return row?.keepUntilExit ?? false;
  },

  /** Turn it on or off. Off lets the contacts waiting at the end leave */
  async setKeepUntilExit(projectId: string, workflowId: string, keepUntilExit: boolean): Promise<void> {
    await prisma.$transaction(async tx => {
      await tx.plunkLiteWorkflowSettings.upsert({
        where: {workflowId},
        create: {workflowId, projectId, keepUntilExit},
        update: {keepUntilExit},
      });
      if (!keepUntilExit) {
        await tx.plunkLiteParkedRun.deleteMany({where: {workflowId}});
      }
    }, POOL_WAIT_TRANSACTION);
  },

  /**
   * Complete a run (`where` and `data` as the engine has them) and park it at `stepId`, if its
   * workflow still keeps its contacts and its contact has entered the workflow no later run. Under
   * the workflow entry's lock, so that a contact entering again at the same moment either sees the
   * parked row (and lets it go) or comes after it; and reading the switch FOR SHARE, so that turning
   * it off at the same moment either comes after the row (and lets it go) or before it (no row).
   */
  async completeAndPark(
    run: RunToPark,
    stepId: string,
    branch: string | null,
    where: Prisma.WorkflowExecutionWhereInput,
    data: Prisma.WorkflowExecutionUncheckedUpdateManyInput,
  ): Promise<void> {
    await prisma.$transaction(async tx => {
      await lockEntry(tx, run.workflowId, run.contactId);
      const {count} = await tx.workflowExecution.updateMany({where: {...where, id: run.id}, data});
      if (count === 0) {
        return;
      }
      await tx.$executeRaw`
        INSERT INTO "plunk_lite_parked_runs" ("executionId", "workflowId", "projectId", "contactId", "stepId", "branch")
        SELECT ${run.id}, s."workflowId", s."projectId", ${run.contactId}, ${stepId}, ${branch}
        FROM "plunk_lite_workflow_settings" s
        WHERE s."workflowId" = ${run.workflowId} AND s."keepUntilExit"
          AND NOT EXISTS (
            SELECT 1 FROM "workflow_executions" o
            WHERE o."workflowId" = ${run.workflowId} AND o."contactId" = ${run.contactId} AND o."id" <> ${run.id}
              AND o."startedAt" > (SELECT x."startedAt" FROM "workflow_executions" x WHERE x."id" = ${run.id})
          )
        FOR SHARE OF s
        ON CONFLICT ("executionId") DO UPDATE
          SET "stepId" = EXCLUDED."stepId", "branch" = EXCLUDED."branch", "parkedAt" = now()
      `;
    }, POOL_WAIT_TRANSACTION);
  },

  /**
   * In the transaction that deletes steps of a workflow, before it does (their step executions go
   * with them): the runs waiting at them wait at the last step each did before them instead
   */
  parkBeforeDeletedSteps(tx: Prisma.TransactionClient, workflowId: string, deletedStepIds: string[]): Promise<void> {
    return deletedStepIds.length > 0 ? parkBeforeGoneSteps(tx, workflowId, deletedStepIds) : Promise.resolve();
  },

  /**
   * The runs of a workflow parked at a step deleted meanwhile (parked while it was being deleted):
   * they wait at the last step each did that is still there
   */
  parkBeforeMissingSteps(workflowId: string): Promise<void> {
    return parkBeforeGoneSteps(prisma, workflowId, null);
  },

  /**
   * Undo a claim whose run could not carry on (it could not be read, or its step was deleted after
   * it was let continue): back to finished, and waiting where it was if the workflow still keeps
   * its contacts. Returns false if the run had moved on meanwhile.
   */
  async unclaim(executionId: string, claimed: ParkedAt): Promise<boolean> {
    return prisma.$transaction(async tx => {
      const {count} = await tx.workflowExecution.updateMany({
        // A deleted step leaves its runs on no step
        where: {
          id: executionId,
          status: WorkflowExecutionStatus.RUNNING,
          OR: [{currentStepId: claimed.stepId}, {currentStepId: null}],
        },
        data: {status: WorkflowExecutionStatus.COMPLETED, completedAt: new Date(), currentStepId: null},
      });
      if (count === 0) {
        return false;
      }
      await tx.$executeRaw`
        INSERT INTO "plunk_lite_parked_runs" ("executionId", "workflowId", "projectId", "contactId", "stepId", "branch")
        SELECT e."id", e."workflowId", s."projectId", e."contactId", ${claimed.stepId}, ${claimed.branch}
        FROM "workflow_executions" e
        JOIN "plunk_lite_workflow_settings" s ON s."workflowId" = e."workflowId" AND s."keepUntilExit"
        WHERE e."id" = ${executionId}
        ON CONFLICT ("executionId") DO NOTHING
      `;
      return true;
    }, POOL_WAIT_TRANSACTION);
  },

  /**
   * Claim a parked run to let it continue, if it still waits where it was picked (`at`): under the
   * workflow entry's lock, and only while its workflow is enabled, keeps its contacts and its project
   * is not disabled (otherwise it keeps waiting). If its contact has a run of the workflow in
   * progress, or a later one, it is let go instead. The claimed run is RUNNING at the step it waited
   * at. Returns where it waited, or null.
   */
  async claim(executionId: string, at: ParkedAt): Promise<ParkedAt | null> {
    const row = await prisma.plunkLiteParkedRun.findUnique({
      where: {executionId},
      select: {workflowId: true, contactId: true},
    });
    if (!row) {
      return null;
    }

    return prisma.$transaction(async tx => {
      await lockEntry(tx, row.workflowId, row.contactId);

      const run = await tx.workflowExecution.findUnique({
        where: {id: executionId},
        select: {
          status: true,
          startedAt: true,
          workflow: {select: {enabled: true, project: {select: {disabled: true}}}},
        },
      });
      const kept = await tx.plunkLiteWorkflowSettings.findUnique({
        where: {workflowId: row.workflowId},
        select: {keepUntilExit: true},
      });
      // Its contact was deleted, it is no longer the finished run it was parked as, or its workflow
      // no longer keeps its contacts
      if (run?.status !== WorkflowExecutionStatus.COMPLETED || !kept?.keepUntilExit) {
        await tx.plunkLiteParkedRun.deleteMany({where: {executionId}});
        return null;
      }
      if (!run.workflow.enabled || run.workflow.project.disabled) {
        return null;
      }

      const other = await tx.workflowExecution.findFirst({
        where: {
          workflowId: row.workflowId,
          contactId: row.contactId,
          id: {not: executionId},
          OR: [{status: WorkflowExecutionStatus.RUNNING}, {startedAt: {gt: run.startedAt}}],
        },
        select: {id: true},
      });
      if (other) {
        await tx.plunkLiteParkedRun.deleteMany({where: {executionId}});
        return null;
      }

      // Only where it was picked: one that waits elsewhere now (it continued already, or the step it
      // waited at was deleted) is not taken further than whoever pressed "Continue" saw
      const [claimed] = await tx.$queryRaw<ParkedAt[]>`
        DELETE FROM "plunk_lite_parked_runs"
        WHERE "executionId" = ${executionId} AND "stepId" = ${at.stepId} AND "branch" IS NOT DISTINCT FROM ${at.branch}
        RETURNING "stepId", "branch"
      `;
      if (!claimed) {
        return null;
      }
      const {count} = await tx.workflowExecution.updateMany({
        where: {id: executionId, status: WorkflowExecutionStatus.COMPLETED},
        data: {status: WorkflowExecutionStatus.RUNNING, currentStepId: claimed.stepId, completedAt: null},
      });
      return count > 0 ? claimed : null;
    }, POOL_WAIT_TRANSACTION);
  },

  /** Let parked runs go: they stay finished. Returns how many */
  async release(
    client: Prisma.TransactionClient,
    where: {executionId: string} | {workflowId: string; contactId?: string},
  ): Promise<number> {
    const {count} = await client.plunkLiteParkedRun.deleteMany({where});
    return count;
  },

  /** Contacts waiting at the end of a workflow, by step and branch */
  async summary(workflowId: string, steps: StepWithTransitions[]): Promise<ParkedGroup[]> {
    const groups = await prisma.$queryRaw<
      {stepId: string; branch: string | null; count: number; unsubscribed: number}[]
    >`
      SELECT p."stepId", p."branch", COUNT(*)::int AS "count",
        COUNT(*) FILTER (WHERE NOT c."subscribed")::int AS "unsubscribed"
      FROM "plunk_lite_parked_runs" p
      ${KEPT}
      JOIN "workflow_executions" e ON e."id" = p."executionId" AND e."status" = ${COMPLETED}
      JOIN "contacts" c ON c."id" = e."contactId"
      WHERE p."workflowId" = ${workflowId}
      GROUP BY p."stepId", p."branch"
      ORDER BY COUNT(*) DESC
    `;

    return groups.map(group => {
      const step = steps.find(s => s.id === group.stepId);
      const branches = step?.type === 'CONDITION' ? conditionBranches(step.config).names : undefined;
      const branchExists =
        step !== undefined && (group.branch === null || branches === undefined || branches.has(group.branch));
      const goesBy = step && !branchExists ? effectiveBranch(step, group.branch) : null;
      return {
        ...group,
        stepName: step?.name ?? null,
        branchName: group.branch === null ? null : (branches?.get(group.branch) ?? group.branch),
        branchExists,
        fallbackBranchName: goesBy ? (branches?.get(goesBy) ?? goesBy) : null,
        canContinue: step !== undefined && nextStepId(step, group.branch) !== undefined,
      };
    });
  },

  /**
   * Let the contacts waiting at the end of a workflow continue into the steps added after where
   * they wait. Refused while the workflow is off or its project disabled, or while a step they could
   * go through is not fully configured. The contacts go in rounds (see `continueRound`), to where
   * they could go now.
   */
  async queueContinue(
    projectId: string,
    workflowId: string,
  ): Promise<{continuable: number; perRound: number; everyMinutes: number}> {
    const workflow = await loadWorkflow(projectId, workflowId);
    if (!workflow) {
      throw new HttpException(404, 'Workflow not found');
    }
    if (!workflow.enabled) {
      throw new HttpException(409, 'Enable the workflow to let its waiting contacts continue');
    }
    if (workflow.project.disabled) {
      throw new HttpException(409, 'This project is disabled');
    }

    const groups = (await this.summary(workflowId, workflow.steps)).filter(group => group.canContinue);
    // Each group where it waits, on its own branch, to the step it goes to now
    const targets = groups.flatMap(group => {
      const step = workflow.steps.find(s => s.id === group.stepId);
      const toStepId = step && nextStepId(step, group.branch);
      return toStepId ? [{stepId: group.stepId, branch: group.branch, toStepId}] : [];
    });
    const problems = routeProblems(workflow.steps, targets);
    if (problems.length > 0) {
      throw new HttpException(422, `Finish the steps they would go through first: ${problems.join('; ')}`);
    }

    const continuable = groups.reduce((sum, group) => sum + group.count, 0);
    if (continuable > 0) {
      const pressId = randomUUID();
      if ((await redis.set(PRESS_KEY(workflowId), pressId, 'EX', PRESS_TTL_SECONDS, 'NX')) !== 'OK') {
        throw new HttpException(409, 'Its waiting contacts are already continuing');
      }
      try {
        await QueueService.queueContinueParkedRound({
          type: 'continue-parked-round',
          projectId,
          workflowId,
          targets,
          pressId,
          round: 0,
        });
      } catch (error) {
        await redis.del(PRESS_KEY(workflowId)).catch(() => undefined);
        throw error;
      }
    }

    return {continuable, ...this.pace()};
  },

  /**
   * One round: up to CONTINUE_PER_ROUND contacts waiting where the press found they could continue,
   * each a job of its own (that claims its run), and the next round queued while there may be more.
   * Only toward the steps they went to when pressed: a target that leads elsewhere now is dropped,
   * and all stop once the workflow is off or its project disabled -- by hand, or by the reputation
   * brake -- or a step on their way is no longer fully configured. The rest keep waiting.
   */
  async continueRound(data: ContinueParkedRoundJobData): Promise<void> {
    // Another press took over once this one lapsed: its rounds go on, these stop
    if ((await redis.get(PRESS_KEY(data.workflowId))) !== data.pressId) {
      signale.info(`[WORKFLOW] A later press lets the contacts of workflow ${data.workflowId} continue`);
      return;
    }
    const more = await this.runRound(data);
    if (more) {
      await redis.expire(PRESS_KEY(data.workflowId), PRESS_TTL_SECONDS);
    } else if ((await redis.get(PRESS_KEY(data.workflowId))) === data.pressId) {
      await redis.del(PRESS_KEY(data.workflowId));
    }
  },

  /** A round of `continueRound`. Returns whether another round follows */
  async runRound(data: ContinueParkedRoundJobData): Promise<boolean> {
    const workflow = await loadWorkflow(data.projectId, data.workflowId);
    if (!workflow?.enabled || workflow.project.disabled) {
      signale.info(`[WORKFLOW] Not letting the contacts of workflow ${data.workflowId} continue: it is off or gone`);
      return false;
    }

    if (data.round === 0) {
      // A deleted contact's rows, and those left at a step deleted as they were parked, once per press
      await prisma.$executeRaw`
        DELETE FROM "plunk_lite_parked_runs" p
        WHERE p."workflowId" = ${data.workflowId}
          AND NOT EXISTS (SELECT 1 FROM "workflow_executions" e WHERE e."id" = p."executionId")
      `;
      await this.parkBeforeMissingSteps(data.workflowId);
    }

    const steps = new Map(workflow.steps.map(step => [step.id, step]));
    const targets = data.targets.filter(target => {
      const step = steps.get(target.stepId);
      return step !== undefined && nextStepId(step, target.branch) === target.toStepId;
    });
    const problems = routeProblems(workflow.steps, targets);
    if (targets.length === 0 || problems.length > 0) {
      signale.warn(
        `[WORKFLOW] Stopped letting the contacts of workflow ${data.workflowId} continue: ` +
          (problems.length > 0 ? problems.join('; ') : 'where they wait leads elsewhere now'),
      );
      return false;
    }

    const rows = await prisma.$queryRaw<{executionId: string; stepId: string; branch: string | null}[]>`
      SELECT p."executionId", p."stepId", p."branch"
      FROM "plunk_lite_parked_runs" p
      ${KEPT}
      JOIN "workflow_executions" e ON e."id" = p."executionId" AND e."status" = ${COMPLETED}
      WHERE p."workflowId" = ${data.workflowId}
        AND ${targetsWhere(targets)}
        ${data.after ? Prisma.sql`AND p."executionId" > ${data.after}` : Prisma.empty}
      ORDER BY p."executionId"
      LIMIT ${CONTINUE_PER_ROUND}
    `;
    if (rows.length === 0) {
      return false;
    }

    await QueueService.queueContinueParked(
      rows.map(row => ({
        ...row,
        toStepId: targets.find(t => t.stepId === row.stepId && t.branch === row.branch)!.toStepId,
      })),
      data.pressId,
    );
    signale.info(`[WORKFLOW] Letting ${rows.length} waiting contact(s) of workflow ${data.workflowId} continue`);

    if (rows.length < CONTINUE_PER_ROUND) {
      return false;
    }
    await QueueService.queueContinueParkedRound(
      {...data, targets, after: rows[rows.length - 1]!.executionId, round: data.round + 1},
      CONTINUE_ROUND_INTERVAL_MS,
    );
    return true;
  },

  /** Which of these runs are parked */
  async parkedIds(executionIds: string[]): Promise<Set<string>> {
    if (executionIds.length === 0) {
      return new Set();
    }
    const rows = await prisma.plunkLiteParkedRun.findMany({
      where: {executionId: {in: executionIds}},
      select: {executionId: true},
    });
    return new Set(rows.map(row => row.executionId));
  },

  /**
   * Distinct contacts waiting at the end of each of these workflows, but for those also in progress
   * there (with re-entry, an earlier run can still wait on a delay): counted once, with the active
   */
  async contactCounts(workflowIds: string[]): Promise<Map<string, number>> {
    if (workflowIds.length === 0) {
      return new Map();
    }
    const rows = await prisma.$queryRaw<{workflowId: string; parked: number}[]>`
      SELECT p."workflowId", COUNT(DISTINCT p."contactId")::int AS "parked"
      FROM "plunk_lite_parked_runs" p
      ${KEPT}
      JOIN "workflow_executions" e ON e."id" = p."executionId" AND e."status" = ${COMPLETED}
      WHERE p."workflowId" IN (${Prisma.join(workflowIds)})
        AND NOT EXISTS (
          SELECT 1 FROM "workflow_executions" a
          WHERE a."workflowId" = p."workflowId" AND a."contactId" = p."contactId"
            AND a."status" IN (${Prisma.join(
              [WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.WAITING].map(
                status => Prisma.sql`${status}::"WorkflowExecutionStatus"`,
              ),
            )})
        )
      GROUP BY p."workflowId"
    `;
    return new Map(rows.map(row => [row.workflowId, row.parked]));
  },

  /** The switch turned on for a workflow being created, in the transaction that creates it */
  async keepFromStart(tx: Prisma.TransactionClient, projectId: string, workflowId: string): Promise<void> {
    await tx.plunkLiteWorkflowSettings.create({data: {workflowId, projectId, keepUntilExit: true}});
  },

  /** A workflow's switch, for a copy of it */
  async copySettings(
    tx: Prisma.TransactionClient,
    projectId: string,
    fromWorkflowId: string,
    toWorkflowId: string,
  ): Promise<void> {
    const source = await tx.plunkLiteWorkflowSettings.findUnique({where: {workflowId: fromWorkflowId}});
    if (source?.keepUntilExit) {
      await this.keepFromStart(tx, projectId, toWorkflowId);
    }
  },

  /** With the workflows being deleted */
  async forgetWorkflows(tx: Prisma.TransactionClient, projectId: string, workflowIds: string[]): Promise<void> {
    await tx.plunkLiteParkedRun.deleteMany({where: {projectId, workflowId: {in: workflowIds}}});
    await tx.plunkLiteWorkflowSettings.deleteMany({where: {projectId, workflowId: {in: workflowIds}}});
  },

  /**
   * With a project's workflows -- deleting or resetting the project. Not async: each returns the
   * query itself, so that they can join a `$transaction([...])` as well as run inside one
   */
  forgetProjectRuns(client: Prisma.TransactionClient, projectId: string) {
    return client.plunkLiteParkedRun.deleteMany({where: {projectId}});
  },
  forgetProjectSettings(client: Prisma.TransactionClient, projectId: string) {
    return client.plunkLiteWorkflowSettings.deleteMany({where: {projectId}});
  },
};
