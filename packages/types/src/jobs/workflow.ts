/**
 * Workflow queue job data types
 */

/**
 * Job data for executing a workflow step
 * Used by: workflowQueue worker
 */
export interface WorkflowStepJobData {
  executionId: string;
  stepId: string;
  // Job type for different handling. Plunk Lite: `continue-parked` lets a run waiting at the end of
  // a workflow continue; its step comes from claiming the run, not from here
  type?: 'process-step' | 'timeout' | 'delay-end' | 'webhook-retry' | 'resume-step' | 'continue-parked';
  stepExecutionId?: string; // For timeout and webhook-retry jobs, reference to the step execution
}

/**
 * Plunk Lite: one round of letting the contacts waiting at the end of a workflow continue
 * Used by: workflowQueue worker
 */
export interface ContinueParkedRoundJobData {
  type: 'continue-parked-round';
  projectId: string;
  workflowId: string;
  /** One per press of "Continue": the jobs of each press have IDs of their own */
  pressId: string;
  round: number;
  /** The last run the round before let continue (they go in ID order) */
  after?: string;
}

/** What a workflowQueue job carries */
export type WorkflowQueueJobData = WorkflowStepJobData | ContinueParkedRoundJobData;
