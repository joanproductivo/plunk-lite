import type {Prisma} from '@plunk/db';

/**
 * The transition a run follows out of a step, given what the step returned: the first, by
 * priority, with no condition, or whose `branch` is the branch the step took (a CONDITION step).
 * Transitions come ordered by priority. Undefined when none applies: the run has nowhere to go.
 *
 * Plunk Lite: one rule for the engine and for what can tell, without running a step, where a run
 * would go from it (the contacts that wait at the end of a workflow).
 */
export function pickTransition<T extends {condition: Prisma.JsonValue}>(
  transitions: readonly T[],
  stepResult: {branch?: unknown},
): T | undefined {
  return transitions.find(({condition}) => {
    // If no condition, always follow
    if (!condition) {
      return true;
    }

    // For CONDITION steps, check the branch
    return Boolean(stepResult.branch) && transitionBranch(condition) === stepResult.branch;
  });
}

/** The branch a transition belongs to (one out of a CONDITION step), if any */
export function transitionBranch(condition: Prisma.JsonValue): string | null {
  return condition && typeof condition === 'object' && !Array.isArray(condition) && typeof condition.branch === 'string'
    ? condition.branch
    : null;
}
