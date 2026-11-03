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
    return (
      Boolean(stepResult.branch) &&
      typeof condition === 'object' &&
      !Array.isArray(condition) &&
      'branch' in condition &&
      condition.branch === stepResult.branch
    );
  });
}
