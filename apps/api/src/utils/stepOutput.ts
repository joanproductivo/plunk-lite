import type {Prisma} from '@plunk/db';

/** Plunk Lite: what a step execution stored as its output, as an object ({} for anything else) */
export function stepOutput(output: Prisma.JsonValue): Record<string, unknown> {
  return output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, unknown>) : {};
}
