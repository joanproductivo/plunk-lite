/**
 * Background Job: Workflow Queue Processor
 * Processes workflow steps from the queue (for delayed steps)
 */

import type {WorkflowQueueJobData} from '@plunk/types';
import {DelayedError, type Job, Worker} from 'bullmq';
import signale from 'signale';

import {DateWaits} from '../services/DateWaits.js';
import {FailureAlertService} from '../services/FailureAlertService.js';
import {ParkedRuns} from '../services/ParkedRuns.js';
import {workflowQueue} from '../services/QueueService.js';
import {WorkflowExecutionService} from '../services/WorkflowExecutionService.js';

export function createWorkflowWorker() {
  const worker = new Worker<WorkflowQueueJobData>(
    workflowQueue.name,
    async (job: Job<WorkflowQueueJobData>, token?: string) => {
      // Plunk Lite: a round of letting the contacts waiting at the end of a workflow continue
      if (job.data.type === 'continue-parked-round') {
        await ParkedRuns.continueRound(job.data);
        return;
      }
      // Plunk Lite: a round of moving the contacts waiting at a date wait to its new date or spread
      if (job.data.type === 'reschedule-date-wait') {
        await DateWaits.rescheduleRound(job.data);
        return;
      }

      const {executionId, stepId, type, stepExecutionId} = job.data;

      if (type === 'timeout') {
        // Handle timeout for WAIT_FOR_EVENT steps
        if (!stepExecutionId) {
          throw new Error('stepExecutionId is required for timeout jobs');
        }

        await WorkflowExecutionService.processTimeout(executionId, stepId, stepExecutionId);
      } else if (type === 'delay-end') {
        // End a DELAY: move on to the step after it, or complete the execution. Plunk Lite: a wait
        // until a date moved later waits the time left, as this same job (no attempt used up)
        const left = await WorkflowExecutionService.processDelayEnd(executionId, stepId);
        if (left > 0) {
          await job.moveToDelayed(Date.now() + left, token);
          throw new DelayedError();
        }
      } else if (type === 'webhook-retry') {
        // The next attempt of a webhook that failed for a reason that may pass
        if (!stepExecutionId) {
          throw new Error('stepExecutionId is required for webhook-retry jobs');
        }

        await WorkflowExecutionService.processWebhookRetry(executionId, stepId, stepExecutionId);
      } else if (type === 'resume-step') {
        // A failed run someone chose to retry, already claimed as running
        await WorkflowExecutionService.processStepExecution(executionId, stepId);
      } else if (type === 'continue-parked') {
        // Plunk Lite: a run waiting at the end of a workflow, let continue (it claims itself)
        await WorkflowExecutionService.continueParked(executionId, {
          stepId,
          branch: job.data.branch ?? null,
          toStepId: job.data.toStepId ?? '',
        });
      } else {
        // A step queued for after a delay, by jobs from before delays ended through delay-end:
        // ended through the delay the run waits on, if it still does
        await WorkflowExecutionService.resumeLegacyStep(executionId);
      }
    },
    {
      connection: workflowQueue.opts.connection,
      concurrency: 10, // Process up to 10 workflow steps concurrently
    },
  );

  worker.on('completed', job => {
    signale.info(`[WORKFLOW-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[WORKFLOW-PROCESSOR] Job ${job?.id} failed:`, err.message);
    if (job && 'executionId' in job.data && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void FailureAlertService.recordWorkflowJob(job.data.executionId, err.message);
    }
    // Plunk Lite: contacts that could not be moved to a new date may end at the old one
    if (job?.data.type === 'reschedule-date-wait' && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void FailureAlertService.recordDateWaitReschedule(job.data.stepId, err.message);
    }
  });

  worker.on('error', err => {
    signale.error('[WORKFLOW-PROCESSOR] Worker error:', err);
  });

  return worker;
}
