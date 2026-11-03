import type {Prisma} from '@plunk/db';

/**
 * The lock deciding whether a contact enters a workflow, for this transaction (see
 * WorkflowEntryService). Plunk Lite: also taken where a run is parked at the end of a workflow, or
 * let continue from there (ParkedRuns), so that entering again and either never cross.
 */
export async function lockEntry(tx: Prisma.TransactionClient, workflowId: string, contactId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`workflow-entry:${workflowId}:${contactId}`}))`;
}
