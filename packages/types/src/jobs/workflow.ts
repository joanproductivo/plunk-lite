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
  // a workflow continue, if it still waits at `stepId` on `branch`
  type?: 'process-step' | 'timeout' | 'delay-end' | 'webhook-retry' | 'resume-step' | 'continue-parked';
  stepExecutionId?: string; // For timeout and webhook-retry jobs, reference to the step execution
  /** Plunk Lite: for continue-parked, the branch the run waited on at `stepId` when it was picked */
  branch?: string | null;
}

/**
 * Plunk Lite: where the contacts let continue by one press of "Continue" wait, and the step they
 * go to from there, as they were when it was pressed
 */
export interface ContinueParkedTarget {
  stepId: string;
  /** The branch they wait on, or null for every branch (the step has a transition anyone follows) */
  branch: string | null;
  toStepId: string;
}

/**
 * Plunk Lite: one round of letting the contacts waiting at the end of a workflow continue
 * Used by: workflowQueue worker
 */
export interface ContinueParkedRoundJobData {
  type: 'continue-parked-round';
  projectId: string;
  workflowId: string;
  /** Only these contacts continue, and only while each still goes where it did when pressed */
  targets: ContinueParkedTarget[];
  /** One per press of "Continue": the jobs of each press have IDs of their own */
  pressId: string;
  round: number;
  /** The last run the round before let continue (they go in ID order) */
  after?: string;
}

/** What a workflowQueue job carries */
export type WorkflowQueueJobData = WorkflowStepJobData | ContinueParkedRoundJobData;
