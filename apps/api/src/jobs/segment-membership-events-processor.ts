/**
 * Segment Membership Events Worker
 * Fires the entry/exit events of segment membership changes made over HTTP (static, or Plunk Lite:
 * a dynamic segment recomputed from the dashboard), and (Plunk Lite) the subscription events of
 * bulk subscription changes and of /v1/send's sign-ups, in one ordered queue
 */

import {segmentEventName} from '@plunk/shared';
import type {MembershipEventsJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {EventService} from '../services/EventService.js';
import {segmentMembershipEventsQueue} from '../services/QueueService.js';
import {isInfrastructureError} from '../utils/infrastructureErrors.js';

/**
 * Track the job's events, resuming after the contacts a previous run already handled.
 *
 * Progress is the number of contacts done, so a run cut short (a restart, a Redis error) picks
 * up from there. (Plunk Lite) With the database or Redis out, the job fails at the contact it
 * reached, instead of skipping every one left, and is retried from it. The contact in flight when
 * it stopped gets its event again; its workflow execution may be left mid-way, and only re-runs
 * if the workflow allows re-entry and that execution had already finished or was waiting.
 *
 * The events keep the name the segment had when the change was made. A segment deleted, or no
 * longer tracking membership, by the time the job runs fires nothing.
 */
export async function processSegmentMembershipEvents(job: Job<MembershipEventsJobData>): Promise<void> {
  const start = typeof job.progress === 'number' ? job.progress : 0;

  // Plunk Lite: the events of a subscription change, with the same progress
  if (job.data.type === 'contact-subscription') {
    const {projectId, eventName, contactIds} = job.data;
    const remaining = contactIds.slice(start);
    // Only the contacts still as the event tells: one that unsubscribed while its contact.subscribed
    // waited behind a long job is not told it subscribed after it left (and the other way round)
    const current = await contactsSubscribedAs(projectId, remaining, eventName === 'contact.subscribed');
    const positions = remaining.flatMap((id, index) => (current.has(id) ? [index] : []));
    await EventService.trackEventsSequentially(
      projectId,
      eventName,
      positions.map(index => remaining[index]!),
      undefined,
      {
        // Progress counts the job's contacts, so a resumed run skips the ones it left out too
        onTracked: async done => job.updateProgress(start + positions[done - 1]! + 1),
        rethrow: isInfrastructureError,
      },
    );
    return;
  }

  // A segment's, also the ones queued before the queue carried a type
  const {projectId, segmentId, segmentName, kind, contactIds} = job.data;

  const segment = await prisma.segment.findFirst({
    where: {id: segmentId, projectId},
    select: {trackMembership: true},
  });
  if (!segment?.trackMembership) {
    signale.info(`[SEGMENT-EVENTS-WORKER] Segment ${segmentId} is gone or no longer tracked; skipping ${kind} events`);
    return;
  }

  await EventService.trackEventsSequentially(
    projectId,
    segmentEventName(segmentName, kind),
    contactIds.slice(start),
    {segmentId, segmentName},
    {onTracked: async done => job.updateProgress(start + done), rethrow: isInfrastructureError},
  );
}

/** Plunk Lite: which of these contacts are (or are not, with `subscribed` false) subscribed now */
async function contactsSubscribedAs(projectId: string, contactIds: string[], subscribed: boolean): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < contactIds.length; i += 1000) {
    const rows = await prisma.contact.findMany({
      where: {projectId, id: {in: contactIds.slice(i, i + 1000)}, subscribed},
      select: {id: true},
    });
    for (const row of rows) {
      found.add(row.id);
    }
  }
  return found;
}

/**
 * Create and export the segment membership events worker
 */
export function createSegmentMembershipEventsWorker(): Worker {
  const worker = new Worker<MembershipEventsJobData>(
    segmentMembershipEventsQueue.name,
    async (job: Job<MembershipEventsJobData>) => {
      await processSegmentMembershipEvents(job);
    },
    {
      connection: segmentMembershipEventsQueue.opts.connection,
      // One job at a time, so a contact's entry and exit usually run in the order they were
      // queued. Not guaranteed: a job retried after an error goes to the back, and after a
      // restart the interrupted job only returns once it is detected as stalled, which can be
      // after the next job has started.
      concurrency: 1,
      // A stalled job resumes from its progress, so surviving several restarts is safe
      maxStalledCount: 10,
    },
  );

  worker.on('failed', (job, error) => {
    signale.error(`[SEGMENT-EVENTS-WORKER] Job ${job?.id} failed:`, error);
  });

  worker.on('error', error => {
    signale.error('[SEGMENT-EVENTS-WORKER] Worker error:', error);
  });

  return worker;
}
