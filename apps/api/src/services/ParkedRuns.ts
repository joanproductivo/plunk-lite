import type {WorkflowStep} from '@plunk/db';
import {Prisma, WorkflowExecutionStatus} from '@plunk/db';
import {WorkflowStepConfigSchemas} from '@plunk/shared';
import type {ContinueParkedRoundJobData, ParkedGroup} from '@plunk/types';
import {randomUUID} from 'node:crypto';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';
import {pickTransition} from '../utils/workflowTransitions.js';

import {QueueService} from './QueueService.js';
import {lockEntry} from './WorkflowEntryService.js';

/**
 * Plunk Lite: workflows that keep their contacts until an Exit step, as Flodesk does.
 *
 * With `keepUntilExit` on, a run that reaches the end of the workflow without an Exit step -- a step
 * with nothing after it, or a condition's branch that leads nowhere -- is COMPLETED as Plunk has it,
 * and parked: a row here says at which step it waits, and the branch that step took. When steps are
 * added after that point, whoever runs the workflow lets those contacts continue into them
 * (`queueContinue`), in rounds, and each run then carries on from where it waited.
 *
 * A parked row is only good while its run is still COMPLETED: every query joins the run. Rows go
 * with their workflow or project here, next to each delete; a deleted contact's go lazily.
 */

/** Contacts let continue in one round, and the time between rounds */
export const CONTINUE_PER_ROUND = 200;
export const CONTINUE_ROUND_INTERVAL_MS = 2 * 60_000;

const COMPLETED = Prisma.sql`${WorkflowExecutionStatus.COMPLETED}::"WorkflowExecutionStatus"`;

type StepWithTransitions = Pick<WorkflowStep, 'id' | 'name' | 'type' | 'config' | 'templateId'> & {
  outgoingTransitions: Array<{condition: Prisma.JsonValue; priority: number; toStepId: string}>;
};

/** A run as parking it needs it */
interface RunToPark {
  id: string;
  workflowId: string;
  contactId: string;
}

/** The branches a condition step has now */
function conditionBranches(config: Prisma.JsonValue): string[] {
  const parsed = WorkflowStepConfigSchemas.condition.safeParse(config);
  if (parsed.success && 'mode' in parsed.data && parsed.data.mode === 'multi') {
    return [...parsed.data.branches.map(branch => branch.id), 'default'];
  }
  return ['yes', 'no'];
}

/** The step a run waiting at `step` on `branch` would go to now, if any (the engine's own rule) */
function nextStepId(step: StepWithTransitions, branch: string | null): string | undefined {
  const byPriority = [...step.outgoingTransitions].sort((a, b) => a.priority - b.priority);
  return pickTransition(byPriority, branch ? {branch} : {})?.toStepId;
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

/**
 * Where the runs parked at a step can continue: by step, any branch (it has a transition anyone
 * follows), or only some branches
 */
function continuableTargets(steps: StepWithTransitions[]): {anyBranch: string[]; byBranch: [string, string][]} {
  const anyBranch: string[] = [];
  const byBranch: [string, string][] = [];

  for (const step of steps) {
    if (nextStepId(step, null)) {
      anyBranch.push(step.id);
      continue;
    }
    for (const {condition} of step.outgoingTransitions) {
      const branch =
        condition && typeof condition === 'object' && !Array.isArray(condition) && typeof condition.branch === 'string'
          ? condition.branch
          : null;
      if (branch && nextStepId(step, branch)) {
        byBranch.push([step.id, branch]);
      }
    }
  }

  return {anyBranch, byBranch};
}

/** A SQL condition on parked rows `p`: waiting where they can continue now */
function continuableWhere({anyBranch, byBranch}: ReturnType<typeof continuableTargets>): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (anyBranch.length > 0) {
    conditions.push(Prisma.sql`p."stepId" IN (${Prisma.join(anyBranch)})`);
  }
  if (byBranch.length > 0) {
    conditions.push(
      Prisma.sql`(p."stepId", p."branch") IN (${Prisma.join(byBranch.map(([stepId, branch]) => Prisma.sql`(${stepId}, ${branch})`))})`,
    );
  }
  return conditions.length > 0 ? Prisma.sql`(${Prisma.join(conditions, ' OR ')})` : Prisma.sql`FALSE`;
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
          outgoingTransitions: {select: {condition: true, priority: true, toStepId: true}},
        },
      },
    },
  });
}

export const ParkedRuns = {
  /** Whether a workflow keeps its contacts until an Exit step */
  async keepsUntilExit(workflowId: string): Promise<boolean> {
    const row = await prisma.plunkLiteWorkflowSettings.findUnique({where: {workflowId}, select: {keepUntilExit: true}});
    return row?.keepUntilExit ?? false;
  },

  /** Turn it on or off. Off lets the contacts waiting at the end leave: returns how many */
  async setKeepUntilExit(projectId: string, workflowId: string, keepUntilExit: boolean): Promise<number> {
    return prisma.$transaction(async tx => {
      await tx.plunkLiteWorkflowSettings.upsert({
        where: {workflowId},
        create: {workflowId, projectId, keepUntilExit},
        update: {keepUntilExit},
      });
      if (keepUntilExit) {
        return 0;
      }
      const {count} = await tx.plunkLiteParkedRun.deleteMany({where: {workflowId}});
      return count;
    });
  },

  /**
   * Complete a run (`where` and `data` as the engine has them) and park it at `stepId`, if its
   * workflow still keeps its contacts. Under the workflow entry's lock, so that a contact entering
   * again at the same moment either sees the parked row (and lets it go) or comes after it.
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
        ON CONFLICT ("executionId") DO UPDATE
          SET "stepId" = EXCLUDED."stepId", "branch" = EXCLUDED."branch", "parkedAt" = now()
      `;
    });
  },

  /**
   * Park again, at the last step each run did that is not being deleted, the runs waiting at steps
   * being deleted: what is connected after that step from then on reaches them. In the transaction
   * that deletes the steps, before it does (their step executions go with them).
   */
  async parkBeforeDeletedSteps(tx: Prisma.TransactionClient, deletedStepIds: string[]): Promise<void> {
    if (deletedStepIds.length === 0) {
      return;
    }
    const moved = await tx.$queryRaw<{executionId: string}[]>`
      DELETE FROM "plunk_lite_parked_runs" WHERE "stepId" IN (${Prisma.join(deletedStepIds)}) RETURNING "executionId"
    `;
    await this.parkAtLastStep(
      tx,
      moved.map(row => row.executionId),
      deletedStepIds,
    );
  },

  /**
   * Park runs at the last step each did that is not one of `excludedStepIds`, with the branch it
   * took. A run with no such step is not parked.
   */
  async parkAtLastStep(tx: Prisma.TransactionClient, executionIds: string[], excludedStepIds: string[]): Promise<void> {
    if (executionIds.length === 0) {
      return;
    }
    await tx.$executeRaw`
      INSERT INTO "plunk_lite_parked_runs" ("executionId", "workflowId", "projectId", "contactId", "stepId", "branch")
      SELECT DISTINCT ON (se."executionId") se."executionId", e."workflowId", w."projectId", e."contactId", se."stepId",
        se."output"->>'branch'
      FROM "workflow_step_executions" se
      JOIN "workflow_executions" e ON e."id" = se."executionId"
      JOIN "workflows" w ON w."id" = e."workflowId"
      WHERE se."executionId" IN (${Prisma.join(executionIds)})
        AND se."status" = 'COMPLETED'
        ${excludedStepIds.length > 0 ? Prisma.sql`AND se."stepId" NOT IN (${Prisma.join(excludedStepIds)})` : Prisma.empty}
      ORDER BY se."executionId", se."completedAt" DESC NULLS LAST, se."createdAt" DESC, se."id" DESC
      ON CONFLICT ("executionId") DO UPDATE SET "stepId" = EXCLUDED."stepId", "branch" = EXCLUDED."branch"
    `;
  },

  /**
   * Undo a claim whose run could not carry on (it could not even be read): back to finished, and
   * waiting where it was. Returns false if the run had moved on meanwhile.
   */
  async unclaim(executionId: string, claimed: {stepId: string; branch: string | null}): Promise<boolean> {
    return prisma.$transaction(async tx => {
      const {count} = await tx.workflowExecution.updateMany({
        where: {id: executionId, status: WorkflowExecutionStatus.RUNNING, currentStepId: claimed.stepId},
        data: {status: WorkflowExecutionStatus.COMPLETED, completedAt: new Date(), currentStepId: null},
      });
      if (count === 0) {
        return false;
      }
      await tx.$executeRaw`
        INSERT INTO "plunk_lite_parked_runs" ("executionId", "workflowId", "projectId", "contactId", "stepId", "branch")
        SELECT e."id", e."workflowId", w."projectId", e."contactId", ${claimed.stepId}, ${claimed.branch}
        FROM "workflow_executions" e JOIN "workflows" w ON w."id" = e."workflowId"
        WHERE e."id" = ${executionId}
        ON CONFLICT ("executionId") DO NOTHING
      `;
      return true;
    });
  },

  /**
   * Claim a parked run to let it continue: under the workflow entry's lock, only while its workflow
   * is enabled and its project is not disabled (otherwise it keeps waiting), and only if its contact
   * has no other run of the workflow in progress or newer (then it is let go instead). The claimed
   * run is RUNNING at the step it waited at. Returns that step and the branch it took, or null.
   */
  async claim(executionId: string): Promise<{stepId: string; branch: string | null} | null> {
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
      // Its contact was deleted, or it is no longer the finished run it was parked as
      if (run?.status !== WorkflowExecutionStatus.COMPLETED) {
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
          OR: [
            {status: {in: [WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.WAITING]}},
            {startedAt: {gt: run.startedAt}},
          ],
        },
        select: {id: true},
      });
      if (other) {
        await tx.plunkLiteParkedRun.deleteMany({where: {executionId}});
        return null;
      }

      const [claimed] = await tx.$queryRaw<{stepId: string; branch: string | null}[]>`
        DELETE FROM "plunk_lite_parked_runs" WHERE "executionId" = ${executionId} RETURNING "stepId", "branch"
      `;
      if (!claimed) {
        return null;
      }
      const {count} = await tx.workflowExecution.updateMany({
        where: {id: executionId, status: WorkflowExecutionStatus.COMPLETED},
        data: {status: WorkflowExecutionStatus.RUNNING, currentStepId: claimed.stepId, completedAt: null},
      });
      return count > 0 ? claimed : null;
    });
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
      JOIN "workflow_executions" e ON e."id" = p."executionId" AND e."status" = ${COMPLETED}
      JOIN "contacts" c ON c."id" = e."contactId"
      WHERE p."workflowId" = ${workflowId}
      GROUP BY p."stepId", p."branch"
      ORDER BY COUNT(*) DESC
    `;

    return groups.map(group => {
      const step = steps.find(s => s.id === group.stepId);
      return {
        ...group,
        stepName: step?.name ?? null,
        branchExists:
          group.branch === null || step?.type !== 'CONDITION' || conditionBranches(step.config).includes(group.branch),
        canContinue: step !== undefined && nextStepId(step, group.branch) !== undefined,
      };
    });
  },

  /**
   * Let the contacts waiting at the end of a workflow continue into the steps added after where
   * they wait. Refused while the workflow is off or its project disabled, or while a step they
   * would go to is not fully configured. The contacts go in rounds (see `continueRound`).
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
    const problems = new Set<string>();
    for (const group of groups) {
      const step = workflow.steps.find(s => s.id === group.stepId);
      const target = step && workflow.steps.find(s => s.id === nextStepId(step, group.branch));
      const problem = target && stepProblem(target);
      if (problem) {
        problems.add(problem);
      }
    }
    if (problems.size > 0) {
      throw new HttpException(422, `Finish the steps they would go to first: ${[...problems].join('; ')}`);
    }

    const continuable = groups.reduce((sum, group) => sum + group.count, 0);
    if (continuable > 0) {
      await QueueService.queueContinueParkedRound({
        type: 'continue-parked-round',
        projectId,
        workflowId,
        pressId: randomUUID(),
        round: 0,
      });
    }

    return {continuable, perRound: CONTINUE_PER_ROUND, everyMinutes: CONTINUE_ROUND_INTERVAL_MS / 60_000};
  },

  /**
   * One round: up to CONTINUE_PER_ROUND contacts of the workflow that can continue now, each a job
   * of its own (that claims its run), and the next round queued while there may be more. Stops once
   * the workflow is off or its project disabled -- by hand, or by the reputation brake -- leaving
   * the rest waiting.
   */
  async continueRound(data: ContinueParkedRoundJobData): Promise<void> {
    const workflow = await loadWorkflow(data.projectId, data.workflowId);
    if (!workflow?.enabled || workflow.project.disabled) {
      signale.info(`[WORKFLOW] Not letting the contacts of workflow ${data.workflowId} continue: it is off or gone`);
      return;
    }

    // A deleted contact's rows, once per press
    if (data.round === 0) {
      await prisma.$executeRaw`
        DELETE FROM "plunk_lite_parked_runs" p
        WHERE p."workflowId" = ${data.workflowId}
          AND NOT EXISTS (SELECT 1 FROM "workflow_executions" e WHERE e."id" = p."executionId")
      `;
    }

    const rows = await prisma.$queryRaw<{executionId: string}[]>`
      SELECT p."executionId"
      FROM "plunk_lite_parked_runs" p
      JOIN "workflow_executions" e ON e."id" = p."executionId" AND e."status" = ${COMPLETED}
      WHERE p."workflowId" = ${data.workflowId}
        AND ${continuableWhere(continuableTargets(workflow.steps))}
        ${data.after ? Prisma.sql`AND p."executionId" > ${data.after}` : Prisma.empty}
      ORDER BY p."executionId"
      LIMIT ${CONTINUE_PER_ROUND}
    `;
    if (rows.length === 0) {
      return;
    }

    await QueueService.queueContinueParked(
      rows.map(row => row.executionId),
      data.pressId,
    );
    signale.info(`[WORKFLOW] Letting ${rows.length} waiting contact(s) of workflow ${data.workflowId} continue`);

    if (rows.length === CONTINUE_PER_ROUND) {
      await QueueService.queueContinueParkedRound(
        {...data, after: rows[rows.length - 1]!.executionId, round: data.round + 1},
        CONTINUE_ROUND_INTERVAL_MS,
      );
    }
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

  /** Distinct contacts waiting at the end of each of these workflows */
  async contactCounts(workflowIds: string[]): Promise<Map<string, number>> {
    if (workflowIds.length === 0) {
      return new Map();
    }
    const rows = await prisma.$queryRaw<{workflowId: string; parked: number}[]>`
      SELECT p."workflowId", COUNT(DISTINCT p."contactId")::int AS "parked"
      FROM "plunk_lite_parked_runs" p
      JOIN "workflow_executions" e ON e."id" = p."executionId" AND e."status" = ${COMPLETED}
      WHERE p."workflowId" IN (${Prisma.join(workflowIds)})
      GROUP BY p."workflowId"
    `;
    return new Map(rows.map(row => [row.workflowId, row.parked]));
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
      await tx.plunkLiteWorkflowSettings.create({data: {workflowId: toWorkflowId, projectId, keepUntilExit: true}});
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
