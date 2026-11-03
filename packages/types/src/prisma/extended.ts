/**
 * Extended Prisma types
 * Types that extend Prisma models with additional relations or computed fields
 */

import type {
  Workflow,
  WorkflowExecution,
  WorkflowStep,
  WorkflowStepExecution,
  WorkflowTransition,
  Template,
  Contact,
  Prisma,
} from '@plunk/db';

/**
 * Workflow with all steps, transitions, and template details
 * Used for workflow editor and detailed workflow views
 */
export interface WorkflowWithDetails extends Workflow {
  steps: Array<
    WorkflowStep & {
      template?: {id: string; name: string} | null;
      outgoingTransitions: WorkflowTransition[];
      incomingTransitions: WorkflowTransition[];
    }
  >;
}

/**
 * Workflow execution with full context
 * Used for execution details and monitoring
 */
export interface WorkflowExecutionWithDetails extends WorkflowExecution {
  workflow: Workflow;
  contact: {id: string; email: string};
  currentStep?: WorkflowStep | null;
  stepExecutions: WorkflowStepExecution[];
  /** Plunk Lite: a finished run waiting at the end of a workflow that keeps its contacts until an Exit step */
  parked?: boolean;
}

/**
 * Plunk Lite: contacts waiting at one step (and branch) at the end of a workflow that keeps its
 * contacts until an Exit step
 */
export interface ParkedGroup {
  stepId: string;
  stepName: string | null;
  branch: string | null;
  /** False when the branch is no longer one of the condition's: nothing can be connected to it */
  branchExists: boolean;
  count: number;
  /** Of them, unsubscribed: a marketing email skips them */
  unsubscribed: number;
  /** Whether a step now follows where they wait, so that they can continue */
  canContinue: boolean;
}

/**
 * Workflow execution with all relations loaded
 * Used internally by workflow execution engine
 */
export type WorkflowExecutionWithRelations = WorkflowExecution & {
  contact: Contact;
  workflow: Workflow;
};

/**
 * Workflow step with optional template
 * Used by step execution logic
 */
export type WorkflowStepWithTemplate = WorkflowStep & {
  template?: Template | null;
};

/**
 * Workflow step with outgoing transitions loaded
 * Used for flow control and navigation
 */
export type WorkflowStepWithTransitions = WorkflowStep & {
  outgoingTransitions?: Array<{
    id: string;
    condition: Prisma.JsonValue;
    priority: number;
    toStep: WorkflowStep;
  }>;
};

/**
 * Step configuration (JSON value)
 * Type-safe alias for workflow step config
 */
export type StepConfig = Prisma.JsonValue;

/**
 * Step execution result
 * Generic key-value result from step execution
 */
export type StepResult = Record<string, unknown>;
