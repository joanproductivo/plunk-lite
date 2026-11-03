import type {Workflow, WorkflowExecution} from '@plunk/db';
import {Prisma, WorkflowExecutionStatus} from '@plunk/db';

import {prisma} from '../database/prisma.js';

import {ParkedRuns} from './ParkedRuns.js';

export type WorkflowEntryRefusal =
  | {reason: 'already-entered'; status: WorkflowExecutionStatus}
  | {reason: 'in-progress'};

export type WorkflowEntryResult =
  | {entered: true; execution: WorkflowExecution}
  | {entered: false; refusal: WorkflowEntryRefusal};

/**
 * Workflow Entry Service
 * Decides whether a contact enters a workflow, and creates the execution when they do. Both the
 * event trigger and the manual start come through here, so the rules are the same however a run
 * begins:
 *
 * - Once per contact (`allowReentry: false`): never again after any earlier run.
 * - Every time (`allowReentry: true`): again whenever no run is RUNNING. A run WAITING on a
 *   delay or an event does not hold the contact back. Plunk Lite: a run waiting at the end of a
 *   workflow that keeps its contacts until an Exit step (ParkedRuns) is let go: the contact starts
 *   over instead, and does not get the steps added after the end twice.
 *
 * The check and the create run under a transaction-scoped advisory lock per workflow and
 * contact. Without it, two events arriving together (SNS delivers at least once, opens come in
 * bursts) both found no execution and both created one -- two runs, and two emails, even in a
 * workflow that allows no re-entry.
 */

/**
 * The lock deciding whether a contact enters a workflow, for this transaction. Plunk Lite: also
 * taken where a run is parked at the end of a workflow, or let continue from there (ParkedRuns).
 */
export async function lockEntry(tx: Prisma.TransactionClient, workflowId: string, contactId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`workflow-entry:${workflowId}:${contactId}`}))`;
}

export class WorkflowEntryService {
  public static async enter(
    workflow: Pick<Workflow, 'id' | 'allowReentry'>,
    contactId: string,
    triggerStepId: string,
    context: Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined,
  ): Promise<WorkflowEntryResult> {
    // Only the decision is under the lock: the caller runs the execution after this commits,
    // so the row is visible to the jobs it queues and no connection is held while it runs
    return prisma.$transaction(
      async tx => {
        await lockEntry(tx, workflow.id, contactId);

        const existing = await tx.workflowExecution.findFirst({
          where: {
            workflowId: workflow.id,
            contactId,
            // Without re-entry any earlier run counts, whatever its status
            ...(workflow.allowReentry ? {status: WorkflowExecutionStatus.RUNNING} : {}),
          },
          select: {status: true},
        });

        if (existing) {
          return {
            entered: false,
            refusal: workflow.allowReentry
              ? {reason: 'in-progress'}
              : {reason: 'already-entered', status: existing.status},
          };
        }

        const execution = await tx.workflowExecution.create({
          data: {
            workflowId: workflow.id,
            contactId,
            status: WorkflowExecutionStatus.RUNNING,
            currentStepId: triggerStepId,
            context,
          },
        });

        if (workflow.allowReentry) {
          await ParkedRuns.release(tx, {workflowId: workflow.id, contactId});
        }

        return {entered: true, execution};
      },
      // A burst of events for contacts with workflows can queue for a connection; the default
      // two-second wait would drop the trigger
      {maxWait: 10_000, timeout: 10_000},
    );
  }
}
