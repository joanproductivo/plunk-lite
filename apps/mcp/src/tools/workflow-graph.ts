/**
 * Pure helpers behind the workflow tools: step config building and validation,
 * condition branch bookkeeping, and a readable outline of the graph.
 *
 * Kept free of I/O so the rules are unit-testable and the tool handlers stay
 * thin. Nothing here calls the API.
 */

import * as z from 'zod';

/** Step types an agent can add. TRIGGER is created by the API with the workflow. */
export const STEP_TYPES = [
  'SEND_EMAIL',
  'DELAY',
  'WAIT_FOR_EVENT',
  'CONDITION',
  'UPDATE_CONTACT',
  'WEBHOOK',
  'EXIT',
] as const;

export type BuildableStepType = (typeof STEP_TYPES)[number];

export const CONDITION_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'greaterThan',
  'lessThan',
  'greaterThanOrEqual',
  'lessThanOrEqual',
  'exists',
  'notExists',
] as const;

export const DELAY_UNITS = ['minutes', 'hours', 'days'] as const;

/** Plunk Lite: what a DELAY that waits until a date does with a contact who reaches it after the date */
export const DATE_WAIT_IF_LATE = ['skip', 'continue'] as const;

/** Plunk Lite: the longest spread of a DELAY until a date, in minutes */
export const DATE_WAIT_MAX_SPREAD_MINUTES = 1440;

export const WEBHOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const SUBSCRIPTION_ACTIONS = ['none', 'subscribe', 'unsubscribe'] as const;

/** Most segments one UPDATE_CONTACT step can add to, and remove from, each. */
export const MAX_SEGMENT_CHANGES = 20;

const UNIT_SECONDS: Record<(typeof DELAY_UNITS)[number], number> = {minutes: 60, hours: 3600, days: 86400};

/** Upper bound the API enforces on a DELAY step (`WorkflowStepConfigSchemas.delay`). */
export const MAX_DELAY: Record<(typeof DELAY_UNITS)[number], number> = {
  minutes: 365 * 24 * 60,
  hours: 365 * 24,
  days: 365,
};

const MAX_WAIT_SECONDS = 365 * 24 * 60 * 60;

export interface WorkflowTransition {
  id: string;
  fromStepId: string;
  toStepId: string;
  condition?: unknown;
  priority?: number;
}

export interface WorkflowStep {
  id: string;
  type: string;
  name?: string;
  config?: unknown;
  templateId?: string | null;
  template?: {id: string; name?: string} | null;
  outgoingTransitions?: WorkflowTransition[];
  incomingTransitions?: WorkflowTransition[];
}

/** Plunk Lite: contacts waiting at one step (and branch) at the end of a workflow */
export interface ParkedGroup {
  stepId: string;
  stepName: string | null;
  branch: string | null;
  branchName: string | null;
  branchExists: boolean;
  fallbackBranchName?: string | null;
  count: number;
  unsubscribed: number;
  canContinue: boolean;
}

/** Plunk Lite: who waits at a step; for a wait until a date, when it ends (and its spread), and what it reaches */
export interface StepWait {
  stepId: string;
  waiting: number;
  at?: string;
  late?: boolean;
  spreadUntil?: string;
  spreadOverlap?: {stepId: string; at: string; severity: 'error' | 'warning'};
}

export interface Workflow {
  id: string;
  name?: string;
  enabled?: boolean;
  allowReentry?: boolean;
  /** Plunk Lite: contacts who reach the end without an Exit step wait there for new steps */
  keepUntilExit?: boolean;
  /** Plunk Lite: who waits where at the end of the workflow */
  parked?: ParkedGroup[];
  /** Plunk Lite: how fast they continue */
  continuePace?: {perRound: number; everyMinutes: number};
  /** Plunk Lite: contacts waiting at each step, and when each wait until a date ends (`at`, ISO) */
  stepWaits?: StepWait[];
  triggerConfig?: {eventName?: string} | null;
  steps?: WorkflowStep[];
}

/*
 * These mirror `WorkflowStepConfigSchemas` in @plunk/shared. The API stores a
 * step's config without validating it; only the executor parses it, so a bad
 * config surfaces as a FAILED execution for a real contact. Checking here turns
 * that into a tool error the agent can fix. The MCP package is published on its
 * own, so it carries its own copy rather than depending on @plunk/shared. Template
 * IDs are only checked for presence; the API rejects ones outside the project.
 */

const conditionOperator = z.enum(CONDITION_OPERATORS);

/** Every operator but exists / notExists compares against a value; without one, `equals` matches a missing field. */
function needsValue(data: {operator: string; value?: unknown}): boolean {
  return data.operator === 'exists' || data.operator === 'notExists' || data.value !== undefined;
}

const VALUE_REQUIRED = {message: 'A value is required unless the operator is exists or notExists'};

/** A `segment.<id>` field is true or false: anything but equals / notEquals a boolean always takes one path. */
function segmentComparisonOk(field: string, data: {operator: string; value?: unknown}): boolean {
  return (
    !field.startsWith('segment.') ||
    ((data.operator === 'equals' || data.operator === 'notEquals') && typeof data.value === 'boolean')
  );
}

const SEGMENT_COMPARISON = {
  message: 'A segment.<id> field is true or false: compare it with equals or notEquals and a boolean value',
};

/** Segment IDs as the API stores them: UUIDs, at most MAX_SEGMENT_CHANGES, none repeated. */
const segmentIds = z
  .array(z.string().uuid('Segment IDs are UUIDs (see plunk_list_segments)'))
  .max(MAX_SEGMENT_CHANGES)
  .refine(ids => new Set(ids).size === ids.length, {message: 'A segment is listed twice'});

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * Plunk Lite: what is wrong with the date and time zone of a wait until a date, if anything. The
 * API converts the date (and refuses one more than two years ahead); this only checks it can be.
 */
function dateWaitParamsProblem(until: string, timezone: string): string | undefined {
  const match = WALL_TIME.exec(until);
  if (!match) {
    return '`until` must look like 2026-11-22T14:00 (a date and time, without a time zone)';
  }
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (hour > 23 || minute > 59 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return `${until} is not a real day and time`;
  }
  if (/^[+-]/.test(timezone.trim())) {
    return '`timezone` must be a time zone name such as Europe/Madrid, not an offset';
  }
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: timezone});
  } catch {
    return `Unknown time zone "${timezone}"`;
  }
  return undefined;
}

const STEP_CONFIG_SCHEMAS: Record<BuildableStepType, z.ZodType> = {
  SEND_EMAIL: z.object({
    templateId: z.string().min(1),
    recipient: z
      .object({type: z.enum(['CONTACT', 'CUSTOM']), customEmail: z.string().email().optional()})
      .refine((data) => data.type !== 'CUSTOM' || !!data.customEmail, {
        message: 'Custom email is required when recipient type is CUSTOM',
      })
      .optional(),
  }),
  // Plunk Lite: for a duration, or until a date and time in a time zone
  DELAY: z.union([
    z
      .object({amount: z.number().positive(), unit: z.enum(DELAY_UNITS)})
      .refine((data) => data.amount <= MAX_DELAY[data.unit], {message: 'Delay cannot exceed 365 days'}),
    z
      .object({
        until: z.string(),
        timezone: z.string(),
        ifLate: z.enum(DATE_WAIT_IF_LATE).optional(),
        spreadMinutes: z.number().int().min(0).max(DATE_WAIT_MAX_SPREAD_MINUTES).optional(),
      })
      .strict()
      .superRefine((data, ctx) => {
        const problem = dateWaitParamsProblem(data.until, data.timezone);
        if (problem) {
          ctx.addIssue({code: z.ZodIssueCode.custom, message: problem});
        }
      }),
  ]),
  WAIT_FOR_EVENT: z.object({
    scope: z.enum(['contact', 'execution']).optional(),
    eventName: z.string().min(1),
    timeout: z.number().nonnegative().max(MAX_WAIT_SECONDS, 'Timeout cannot exceed 365 days').optional(),
  }),
  CONDITION: z.union([
    z
      .object({field: z.string().min(1), operator: conditionOperator, value: z.unknown().optional()})
      .refine(needsValue, VALUE_REQUIRED)
      .refine(data => segmentComparisonOk(data.field, data), SEGMENT_COMPARISON),
    z
      .object({
        mode: z.literal('multi'),
        field: z.string().min(1),
        branches: z
          .array(
            z
              .object({
                id: z.string().min(1),
                name: z.string().min(1),
                operator: conditionOperator,
                value: z.unknown().optional(),
              })
              .refine(needsValue, VALUE_REQUIRED),
          )
          .min(1)
          .max(20),
      })
      .refine(data => data.branches.every(branch => segmentComparisonOk(data.field, branch)), SEGMENT_COMPARISON),
  ]),
  UPDATE_CONTACT: z
    .object({
      updates: z.record(z.string(), z.unknown()).optional(),
      subscriptionAction: z.enum(SUBSCRIPTION_ACTIONS).optional(),
      segments: z
        .object({add: segmentIds.default([]), remove: segmentIds.default([])})
        .refine(value => !value.add.some(id => value.remove.includes(id)), {
          message: 'A segment cannot be both added and removed',
        })
        .optional(),
    })
    .refine(
      (value) =>
        (value.updates && Object.keys(value.updates).length > 0) ||
        (value.subscriptionAction && value.subscriptionAction !== 'none') ||
        (value.segments && value.segments.add.length + value.segments.remove.length > 0),
      {message: 'Provide at least one field to update, a subscription action or a segment change'},
    ),
  WEBHOOK: z.object({
    url: z.string().url(),
    method: z.enum(WEBHOOK_METHODS).default('POST'),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  }),
  EXIT: z.object({reason: z.string().optional()}),
};

function isBuildable(type: string): type is BuildableStepType {
  return (STEP_TYPES as readonly string[]).includes(type);
}

/** Validates a stored or proposed config. Returns a readable reason, or undefined when valid. */
export function configProblem(type: string, config: unknown): string | undefined {
  if (!isBuildable(type)) {
    return undefined;
  }

  const result = STEP_CONFIG_SCHEMAS[type].safeParse(config ?? {});

  if (result.success) {
    return undefined;
  }

  return result.error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

export interface BranchInput {
  id?: string;
  name: string;
  operator: (typeof CONDITION_OPERATORS)[number];
  value?: unknown;
}

/** The flat, per-type arguments the step tools accept. Each type reads only its own. */
export interface StepParams {
  templateId?: string;
  recipientEmail?: string;
  amount?: number;
  unit?: (typeof DELAY_UNITS)[number];
  until?: string;
  timezone?: string;
  ifLate?: (typeof DATE_WAIT_IF_LATE)[number];
  spreadMinutes?: number;
  eventName?: string;
  field?: string;
  operator?: (typeof CONDITION_OPERATORS)[number];
  value?: unknown;
  branches?: BranchInput[];
  updates?: Record<string, unknown>;
  subscriptionAction?: (typeof SUBSCRIPTION_ACTIONS)[number];
  segments?: {add?: string[]; remove?: string[]};
  url?: string;
  method?: (typeof WEBHOOK_METHODS)[number];
  headers?: Record<string, string>;
  body?: unknown;
  reason?: string;
}

/** Arguments that belong to each step type, used to reject ones that would be silently ignored. */
const PARAMS_BY_TYPE: Record<BuildableStepType, (keyof StepParams)[]> = {
  SEND_EMAIL: ['templateId', 'recipientEmail'],
  DELAY: ['amount', 'unit', 'until', 'timezone', 'ifLate', 'spreadMinutes'],
  WAIT_FOR_EVENT: ['eventName', 'amount', 'unit'],
  CONDITION: ['field', 'operator', 'value', 'branches'],
  UPDATE_CONTACT: ['updates', 'subscriptionAction', 'segments'],
  WEBHOOK: ['url', 'method', 'headers', 'body'],
  EXIT: ['reason'],
};

const ALL_PARAMS = [...new Set(Object.values(PARAMS_BY_TYPE).flat())];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? {...(value as Record<string, unknown>)} : {};
}

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

type NormalisedBranch = {id: string; name: string; operator: string; value?: unknown};

/**
 * Gives every multi-branch entry a stable id. Agents wire branches by id, so a
 * readable slug of the name beats the dashboard's random one. `default` is
 * reserved for the no-match path, so a caller may not use it.
 */
export function normaliseBranches(branches: BranchInput[]): {branches: NormalisedBranch[]} | {error: string} {
  const given = branches.map((branch) => branch.id?.trim()).filter((id): id is string => !!id);

  if (given.includes('default')) {
    return {error: 'Branch id "default" is reserved for contacts that match no branch; pick another id.'};
  }

  const duplicate = given.find((id, index) => given.indexOf(id) !== index);

  if (duplicate) {
    return {error: `Branch id "${duplicate}" is used twice; branch ids must be unique.`};
  }

  const used = new Set<string>(['default', ...given]);

  return {
    branches: branches.map((branch, index) => {
      let id = branch.id?.trim();

      if (!id) {
        const base = slug(branch.name) || `branch-${index + 1}`;
        id = base;

        for (let n = 2; used.has(id); n++) {
          id = `${base}-${n}`;
        }

        used.add(id);
      }

      const entry: NormalisedBranch = {id, name: branch.name, operator: branch.operator};

      if (branch.value !== undefined) {
        entry.value = branch.value;
      }

      return entry;
    }),
  };
}

/**
 * Builds a step config from tool arguments, overlaying `existing` when a step is
 * being edited so that only the arguments passed change. Returns the config, or
 * an error the agent can act on.
 */
export function buildStepConfig(
  type: BuildableStepType,
  params: StepParams,
  existing?: unknown,
): {config: Record<string, unknown>} | {error: string} {
  const stray = ALL_PARAMS.filter((key) => params[key] !== undefined && !PARAMS_BY_TYPE[type].includes(key));

  if (stray.length > 0) {
    return {
      error:
        `${stray.map((key) => `\`${key}\``).join(', ')} ${stray.length === 1 ? 'does' : 'do'} ` +
        `not apply to a ${type} step.`,
    };
  }

  const config = asRecord(existing);

  switch (type) {
    case 'SEND_EMAIL': {
      if (params.templateId !== undefined) {
        config.templateId = params.templateId;
      }

      if (!config.templateId) {
        return {error: 'A SEND_EMAIL step needs a templateId. Call plunk_list_templates to find the template ID.'};
      }

      if (params.recipientEmail !== undefined) {
        // "" switches back to the contact in the workflow.
        if (params.recipientEmail === '') {
          delete config.recipient;
        } else {
          config.recipient = {type: 'CUSTOM', customEmail: params.recipientEmail};
        }
      }
      break;
    }

    case 'DELAY': {
      // Plunk Lite: a wait until a date. Passing one form drops the other's settings
      const date =
        params.until !== undefined ||
        params.timezone !== undefined ||
        params.ifLate !== undefined ||
        params.spreadMinutes !== undefined;
      const duration = params.amount !== undefined || params.unit !== undefined;
      if (date && duration) {
        return {
          error: 'A DELAY waits for a duration (`amount` + `unit`) or until a date (`until` + `timezone`), not both.',
        };
      }
      if (date || (!duration && 'until' in config)) {
        delete config.amount;
        delete config.unit;
        for (const key of ['until', 'timezone', 'ifLate', 'spreadMinutes'] as const) {
          if (params[key] !== undefined) {
            config[key] = params[key];
          }
        }
        if (typeof config.until !== 'string' || typeof config.timezone !== 'string') {
          return {
            error:
              'A DELAY until a date needs both `until` and `timezone` (`ifLate` and `spreadMinutes` only apply to one).',
          };
        }
        return finish(type, config);
      }
      delete config.until;
      delete config.timezone;
      delete config.ifLate;
      delete config.spreadMinutes;

      if (params.amount !== undefined) {
        config.amount = params.amount;
      }
      if (params.unit !== undefined) {
        config.unit = params.unit;
      }

      if (config.amount === undefined || !config.unit) {
        return {error: 'A DELAY step needs both `amount` and `unit`, or `until` and `timezone`.'};
      }

      const unit = config.unit as (typeof DELAY_UNITS)[number];
      if (typeof config.amount === 'number' && config.amount > MAX_DELAY[unit]) {
        return {error: `A delay cannot exceed 365 days (${MAX_DELAY[unit]} ${unit}).`};
      }
      break;
    }

    case 'WAIT_FOR_EVENT': {
      if (params.eventName !== undefined) {
        config.eventName = params.eventName;
      }

      if (!config.eventName) {
        return {error: 'A WAIT_FOR_EVENT step needs the `eventName` to wait for.'};
      }

      if ((params.amount === undefined) !== (params.unit === undefined)) {
        return {error: 'A WAIT_FOR_EVENT timeout needs both `amount` and `unit`; omit both to wait indefinitely.'};
      }

      if (params.amount !== undefined && params.unit) {
        config.timeout = Math.round(params.amount * UNIT_SECONDS[params.unit]);
      }
      break;
    }

    case 'CONDITION': {
      if (params.branches && (params.operator !== undefined || params.value !== undefined)) {
        return {
          error:
            'Pass either `operator`/`value` (a yes/no condition) or `branches` (a multi-branch condition), not both.',
        };
      }

      const field = params.field ?? (config.field as string | undefined);

      if (!field) {
        return {error: 'A CONDITION step needs the `field` to test, e.g. "data.plan" or "contact.subscribed".'};
      }

      const unresolvable = fieldProblem(field);
      if (unresolvable) {
        return {error: unresolvable};
      }

      if (params.branches) {
        const normalised = normaliseBranches(params.branches);

        if ('error' in normalised) {
          return normalised;
        }

        return finish(type, {mode: 'multi', field, branches: normalised.branches});
      }

      if (config.mode === 'multi' && params.operator === undefined && params.value !== undefined) {
        return {
          error:
            'This is a multi-branch condition: change values through `branches`, or pass `operator` to make it yes/no.',
        };
      }

      if (params.operator !== undefined || config.mode !== 'multi') {
        const operator = params.operator ?? (config.mode === 'multi' ? undefined : config.operator);

        if (!operator) {
          return {
            error: 'A yes/no CONDITION step needs an `operator`; for several outcomes pass `branches` instead.',
          };
        }

        const next: Record<string, unknown> = {field, operator};
        const value = params.value !== undefined ? params.value : config.mode === 'multi' ? undefined : config.value;
        if (value !== undefined && operator !== 'exists' && operator !== 'notExists') {
          next.value = value;
        }

        return finish(type, next);
      }

      // Multi-branch, only the field changed.
      return finish(type, {...config, field});
    }

    case 'UPDATE_CONTACT': {
      if (params.updates !== undefined) {
        config.updates = params.updates;
      }
      if (params.subscriptionAction !== undefined) {
        config.subscriptionAction = params.subscriptionAction;
      }
      if (params.segments !== undefined) {
        // A list left out keeps what the step already has; pass [] to clear it.
        const current = asRecord(config.segments);
        config.segments = {
          add: params.segments.add ?? (Array.isArray(current.add) ? current.add : []),
          remove: params.segments.remove ?? (Array.isArray(current.remove) ? current.remove : []),
        };
      }
      break;
    }

    case 'WEBHOOK': {
      if (params.url !== undefined) {
        config.url = params.url;
      }
      if (params.method !== undefined) {
        config.method = params.method;
      }
      if (params.headers !== undefined) {
        config.headers = params.headers;
      }
      if (params.body !== undefined) {
        config.body = params.body;
      }

      if (!config.url) {
        return {error: 'A WEBHOOK step needs a `url`.'};
      }

      config.method ??= 'POST';
      break;
    }

    case 'EXIT': {
      if (params.reason !== undefined) {
        config.reason = params.reason;
      }
      break;
    }
  }

  return finish(type, config);
}

/**
 * The executor resolves a condition field against
 * `{contact: {email, subscribed}, data, event, workflow}` (and rewrites the
 * legacy `contact.data.X` to `data.X`), and `segment.<id>` to whether the
 * contact is in that segment. Any other path is always undefined, so the
 * condition would silently take the same branch for everyone.
 */
export function fieldProblem(field: string): string | undefined {
  if (
    /^(contact\.(email|subscribed)$|contact\.data\.|data\.|event\.|workflow\.|segment\.[0-9a-f-]{36}$)/i.test(field)
  ) {
    return undefined;
  }

  return (
    `The condition field "${field}" never resolves. Use contact.email, contact.subscribed, segment.<segmentId>, ` +
    'data.<field> for contact data, or event.<field> for data of the event that started the workflow.'
  );
}

function finish(
  type: BuildableStepType,
  config: Record<string, unknown>,
): {config: Record<string, unknown>} | {error: string} {
  const problem = configProblem(type, config);
  return problem ? {error: `Invalid ${type} configuration: ${problem}`} : {config};
}

/** A default step name, so the dashboard shows something meaningful. */
export function defaultStepName(type: BuildableStepType, config: Record<string, unknown>): string {
  if (type === 'SEND_EMAIL') {
    return 'Send email';
  }

  const summary = stepSummary({id: '', type, config}) || type;
  return truncate(summary.charAt(0).toUpperCase() + summary.slice(1), 100);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The branch a transition belongs to, if it carries one. */
export function transitionBranch(transition: WorkflowTransition): string | undefined {
  const condition = transition.condition;

  if (condition && typeof condition === 'object' && 'branch' in condition) {
    return String((condition as {branch: unknown}).branch);
  }

  return undefined;
}

/** Branch ids a CONDITION step routes on, or undefined for any other step type. */
export function stepBranches(step: WorkflowStep): string[] | undefined {
  if (step.type !== 'CONDITION') {
    return undefined;
  }

  const config = asRecord(step.config);

  if (config.mode === 'multi' && Array.isArray(config.branches)) {
    return [...(config.branches as {id: string}[]).map((branch) => String(branch.id)), 'default'];
  }

  return ['yes', 'no'];
}

/** Label for a branch id, e.g. a multi-branch entry's name. */
export function branchLabel(step: WorkflowStep, branch: string): string {
  const config = asRecord(step.config);

  if (config.mode === 'multi' && Array.isArray(config.branches)) {
    const match = (config.branches as {id: string; name?: string}[]).find((entry) => entry.id === branch);
    if (match?.name && match.name !== branch) {
      return `${branch} (${match.name})`;
    }
  }

  return branch;
}

export function findStep(workflow: Workflow, stepId: string): WorkflowStep | undefined {
  return workflow.steps?.find((step) => step.id === stepId);
}

/**
 * The outgoing transition occupying a slot: the given branch of a CONDITION
 * step, or the single exit of any other step.
 */
export function slotTransition(step: WorkflowStep, branch?: string): WorkflowTransition | undefined {
  const outgoing = step.outgoingTransitions ?? [];

  if (step.type === 'CONDITION') {
    return outgoing.find((transition) => transitionBranch(transition) === branch);
  }

  return outgoing[0];
}

/**
 * Checks that `branch` is valid for connecting out of `step`. Returns an error
 * the agent can act on, or undefined.
 */
export function branchProblem(step: WorkflowStep, branch: string | undefined): string | undefined {
  if (step.type === 'EXIT') {
    return `"${step.name ?? step.id}" is an EXIT step; it ends the flow and cannot lead to another step.`;
  }

  const branches = stepBranches(step);

  if (!branches) {
    return branch === undefined
      ? undefined
      : `\`branch\` only applies after a CONDITION step; "${step.name ?? step.id}" is a ${step.type} step.`;
  }

  if (branch === undefined) {
    return (
      `"${step.name ?? step.id}" is a CONDITION step, so say which branch to continue on: ` +
      `branch=${branches.map((b) => `"${b}"`).join(' or ')}.`
    );
  }

  if (!branches.includes(branch)) {
    const valid = branches.map((b) => `"${b}"`).join(', ');
    return `"${step.name ?? step.id}" has no branch "${branch}". Its branches are ${valid}.`;
  }

  return undefined;
}

/**
 * Where a step goes when the caller names no position: the one step that has
 * nothing after it yet. Refuses when that is ambiguous — several dead ends, or
 * a CONDITION that needs a branch — rather than guess, since a wrong guess
 * silently reorders who receives which email.
 */
export function defaultAppendPoint(workflow: Workflow): {step: WorkflowStep} | {error: string} {
  const steps = workflow.steps ?? [];
  const leaves = steps.filter((step) => step.type !== 'EXIT' && (step.outgoingTransitions ?? []).length === 0);

  if (leaves.length === 1 && leaves[0]!.type !== 'CONDITION') {
    return {step: leaves[0]!};
  }

  const slots = openSlots(workflow)
    .map(
      (slot) =>
        `after="${slot.step.id}"${slot.branch ? ` branch="${slot.branch}"` : ''} (${slot.step.name ?? slot.step.type})`,
    )
    .join('; ');

  return {
    error:
      'Cannot tell where this step goes: the workflow has ' +
      (leaves.length === 1 ? 'a CONDITION step at the end, which needs a branch' : `${leaves.length} open ends`) +
      `. Pass \`after\` (and \`branch\` after a CONDITION). Open positions: ${slots || 'none'}.`,
  };
}

/** Every place a new step could be attached without displacing an existing one. */
export function openSlots(workflow: Workflow): {step: WorkflowStep; branch?: string}[] {
  const slots: {step: WorkflowStep; branch?: string}[] = [];

  for (const step of workflow.steps ?? []) {
    if (step.type === 'EXIT') {
      continue;
    }

    const branches = stepBranches(step);

    if (branches) {
      for (const branch of branches) {
        if (!slotTransition(step, branch)) {
          slots.push({step, branch});
        }
      }
    } else if ((step.outgoingTransitions ?? []).length === 0) {
      slots.push({step});
    }
  }

  return slots;
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

/** One-line summary of what a step does. */
export function stepSummary(step: WorkflowStep): string {
  const config = asRecord(step.config);

  switch (step.type) {
    case 'TRIGGER':
      return `when "${String(config.eventName ?? '?')}" is tracked`;
    case 'SEND_EMAIL': {
      const template = step.template?.name ? `"${step.template.name}"` : String(config.templateId ?? '?');
      const recipient = asRecord(config.recipient);
      return `send ${template}${recipient.type === 'CUSTOM' ? ` to ${String(recipient.customEmail)}` : ''}`;
    }
    case 'DELAY':
      if (typeof config.until === 'string') {
        const late = config.ifLate === 'continue' ? 'continue' : 'skip';
        const spread =
          typeof config.spreadMinutes === 'number' && config.spreadMinutes > 0
            ? `, spread over ${config.spreadMinutes} min`
            : '';
        return `wait until ${config.until.replace('T', ' ')} ${String(config.timezone ?? '?')} (late: ${late}${spread})`;
      }
      return `wait ${String(config.amount ?? '?')} ${unitLabel(config.amount, config.unit)}`;
    case 'WAIT_FOR_EVENT': {
      const timeout =
        typeof config.timeout === 'number' && config.timeout > 0 ? ` (timeout ${humanSeconds(config.timeout)})` : '';
      return `wait for "${String(config.eventName ?? '?')}"${timeout}`;
    }
    case 'CONDITION': {
      if (config.mode === 'multi' && Array.isArray(config.branches)) {
        const branches = (config.branches as {id: string; operator: string; value?: unknown}[])
          .map((b) => `${b.id}: ${b.operator}${b.value !== undefined ? ` ${formatValue(b.value)}` : ''}`)
          .join(' | ');
        return `switch on ${String(config.field ?? '?')} — ${branches} | default`;
      }
      const value = config.value !== undefined ? ` ${formatValue(config.value)}` : '';
      return `if ${String(config.field ?? '?')} ${String(config.operator ?? '?')}${value}`;
    }
    case 'UPDATE_CONTACT': {
      const parts = Object.entries(asRecord(config.updates)).map(([key, value]) => `${key}=${formatValue(value)}`);
      if (config.subscriptionAction && config.subscriptionAction !== 'none') {
        parts.push(String(config.subscriptionAction));
      }
      const phrases = parts.length > 0 ? [`set ${parts.join(', ')}`] : [];
      const segments = asRecord(config.segments);
      for (const [key, verb] of [
        ['remove', 'remove from'],
        ['add', 'add to'],
      ] as const) {
        const ids = Array.isArray(segments[key]) ? (segments[key] as unknown[]) : [];
        if (ids.length > 0) {
          phrases.push(`${verb} segment${ids.length > 1 ? 's' : ''} ${ids.map(String).join(', ')}`);
        }
      }
      return phrases.join('; ') || 'set ?';
    }
    case 'WEBHOOK':
      return `${String(config.method ?? 'POST')} ${String(config.url ?? '?')}`;
    case 'EXIT':
      return `exit${config.reason ? ` (${String(config.reason)})` : ''}`;
    default:
      return '';
  }
}

function unitLabel(amount: unknown, unit: unknown): string {
  const text = String(unit ?? '?');
  return amount === 1 ? text.replace(/s$/, '') : text;
}

function humanSeconds(seconds: number): string {
  if (seconds % 86400 === 0) {
    return `${seconds / 86400} days`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600} hours`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60} minutes`;
  }
  return `${seconds} seconds`;
}

export interface WorkflowIssue {
  severity: 'error' | 'warning';
  /** `unreachable` marks a step no path from the trigger leads to. */
  code:
    | 'missing_trigger'
    | 'unreachable'
    | 'invalid_config'
    | 'missing_template'
    | 'bad_connection'
    // Plunk Lite: a wait until a date already past, one that skips to the end when late, and one
    // whose spread reaches the next date wait
    | 'date_passed'
    | 'skips_to_end'
    | 'spread_overlaps_next';
  stepId?: string;
  message: string;
}

export interface WorkflowReview {
  outline: string;
  issues: WorkflowIssue[];
}

/**
 * Renders the graph as numbered lines in the order a contact walks it, and
 * lists anything that would fail or misroute at run time. Errors are problems
 * the executor would hit; warnings are probably unintended but valid.
 */
export function reviewWorkflow(workflow: Workflow): WorkflowReview {
  const steps = workflow.steps ?? [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const issues: WorkflowIssue[] = [];
  const order: WorkflowStep[] = [];
  const number = new Map<string, number>();

  const trigger = steps.find((step) => step.type === 'TRIGGER');

  if (!trigger) {
    issues.push({severity: 'error', code: 'missing_trigger', message: 'The workflow has no TRIGGER step.'});
  }

  // Depth-first from the trigger, following branches in declared order, so the
  // numbering matches how the dashboard reads top to bottom.
  const visit = (step: WorkflowStep) => {
    if (number.has(step.id)) {
      return;
    }
    number.set(step.id, order.length + 1);
    order.push(step);

    for (const transition of orderedOutgoing(step)) {
      const next = byId.get(transition.toStepId);
      if (next) {
        visit(next);
      }
    }
  };

  if (trigger) {
    visit(trigger);
  }

  const unreachable = steps.filter((step) => !number.has(step.id));
  for (const step of unreachable) {
    number.set(step.id, order.length + 1);
    order.push(step);
    issues.push({
      severity: 'warning',
      code: 'unreachable',
      stepId: step.id,
      message: `#${number.get(step.id)} "${step.name ?? step.type}" is not connected to the trigger, so it never runs.`,
    });
  }

  const ref = (stepId: string) => (number.has(stepId) ? `#${number.get(stepId)}` : `missing step ${stepId}`);
  const lines: string[] = [];

  for (const step of order) {
    const n = number.get(step.id)!;
    const outgoing = step.outgoingTransitions ?? [];
    const branches = stepBranches(step);
    let exits: string;

    if (step.type === 'EXIT') {
      exits = '';
    } else if (branches) {
      exits = branches
        .map((branch) => {
          const transition = slotTransition(step, branch);
          return `${branchLabel(step, branch)} → ${transition ? ref(transition.toStepId) : 'end'}`;
        })
        .join(', ');
    } else {
      exits = outgoing.length > 0 ? `→ ${outgoing.map((t) => ref(t.toStepId)).join(', ')}` : '→ end';
    }

    const label = step.name && step.name !== stepSummary(step) ? ` "${step.name}"` : '';
    const wait = workflow.stepWaits?.find((entry) => entry.stepId === step.id);
    const ends = wait?.at ? ` (ends ${wait.at}${wait.spreadUntil ? `, spread until ${wait.spreadUntil}` : ''})` : '';
    const waiting = wait?.waiting ? ` — ${wait.waiting} waiting` : '';
    lines.push(
      `#${n} ${step.type}${label}: ${stepSummary(step)}${ends}${waiting}${exits ? `  ${exits}` : ''}  [id ${step.id}]`,
    );

    checkStep(step, issues, n);
    checkDateWait(step, wait, byId, issues, n);
  }

  return {outline: lines.join('\n'), issues};
}

function orderedOutgoing(step: WorkflowStep): WorkflowTransition[] {
  const outgoing = [...(step.outgoingTransitions ?? [])];
  const branches = stepBranches(step);

  if (!branches) {
    return outgoing;
  }

  const rank = (transition: WorkflowTransition) => {
    const index = branches.indexOf(transitionBranch(transition) ?? '');
    return index === -1 ? branches.length : index;
  };

  return outgoing.sort((a, b) => rank(a) - rank(b));
}

function checkStep(step: WorkflowStep, issues: WorkflowIssue[], n: number): void {
  const name = `#${n} "${step.name ?? step.type}"`;
  const outgoing = step.outgoingTransitions ?? [];
  const problem = configProblem(step.type, step.config);

  if (problem) {
    issues.push({
      severity: 'error',
      code: 'invalid_config',
      stepId: step.id,
      message: `${name} has an invalid ${step.type} config: ${problem}`,
    });
  }

  if (step.type === 'SEND_EMAIL' && !step.templateId && !step.template) {
    issues.push({
      severity: 'error',
      code: 'missing_template',
      stepId: step.id,
      message: `${name} has no template attached; set one with plunk_update_workflow_step templateId.`,
    });
  }

  if (step.type === 'EXIT' && outgoing.length > 0) {
    issues.push({
      severity: 'error',
      code: 'bad_connection',
      stepId: step.id,
      message: `${name} is an EXIT step but leads to another step.`,
    });
  }

  if (step.type === 'CONDITION') {
    const field = asRecord(step.config).field;
    const unresolvable = typeof field === 'string' ? fieldProblem(field) : undefined;
    if (unresolvable) {
      issues.push({severity: 'error', code: 'invalid_config', stepId: step.id, message: `${name}: ${unresolvable}`});
    }
  }

  const branches = stepBranches(step);

  if (branches) {
    for (const transition of outgoing) {
      const branch = transitionBranch(transition);

      if (branch === undefined) {
        issues.push({
          severity: 'error',
          code: 'bad_connection',
          stepId: step.id,
          message:
            `${name} has a connection with no branch, which is followed regardless of the condition. ` +
            'Reconnect it on a branch.',
        });
      } else if (!branches.includes(branch)) {
        issues.push({
          severity: 'error',
          code: 'bad_connection',
          stepId: step.id,
          message: `${name} has a connection on branch "${branch}", which its condition no longer produces.`,
        });
      }
    }
  } else if (outgoing.length > 1) {
    issues.push({
      severity: 'error',
      code: 'bad_connection',
      stepId: step.id,
      message: `${name} leads to ${outgoing.length} steps; only the first is ever followed. Use a CONDITION to branch.`,
    });
  }
}

/** Plunk Lite: whether a wait until a date can be reached from `step` (any branch) */
function dateWaitAhead(step: WorkflowStep, byId: Map<string, WorkflowStep>): boolean {
  const seen = new Set<string>([step.id]);
  const queue = (step.outgoingTransitions ?? []).map((transition) => transition.toStepId);
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const next = byId.get(id);
    if (!next || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (next.type === 'DELAY' && typeof asRecord(next.config).until === 'string') {
      return true;
    }
    queue.push(...(next.outgoingTransitions ?? []).map((transition) => transition.toStepId));
  }
  return false;
}

/** Plunk Lite: a date wait already past, that skips to the end when late, or whose spread reaches the next one */
function checkDateWait(
  step: WorkflowStep,
  wait: StepWait | undefined,
  byId: Map<string, WorkflowStep>,
  issues: WorkflowIssue[],
  n: number,
): void {
  const config = asRecord(step.config);
  if (step.type !== 'DELAY' || typeof config.until !== 'string') {
    return;
  }
  const name = `#${n} "${step.name ?? step.type}"`;
  const skip = config.ifLate !== 'continue';

  if (wait?.late) {
    issues.push({
      severity: 'warning',
      code: 'date_passed',
      stepId: step.id,
      message: skip
        ? `${name} waits until a date that has passed: contacts who reach it now skip to the next date wait.`
        : `${name} waits until a date that has passed: contacts who reach it now continue right away.`,
    });
  }
  if (skip && !dateWaitAhead(step, byId)) {
    issues.push({
      severity: 'warning',
      code: 'skips_to_end',
      stepId: step.id,
      message:
        `${name} skips when a contact arrives late, and no date wait follows it: a late contact skips every ` +
        'step after it (emails, webhooks, contact updates) and finishes the workflow.',
    });
  }
  const overlap = wait?.spreadOverlap;
  if (overlap) {
    const next = byId.get(overlap.stepId);
    const where = `"${next?.name ?? 'DELAY'}" (${overlap.at})`;
    issues.push({
      severity: overlap.severity,
      code: 'spread_overlaps_next',
      stepId: step.id,
      message:
        overlap.severity === 'error'
          ? `${name}'s spread reaches the next date wait ${where}: the last contacts would arrive late and skip ` +
            'it. Use a shorter spreadMinutes.'
          : `${name}'s spread may reach the next date wait ${where}: it goes on right away when late, or a ` +
            'WAIT_FOR_EVENT with no timeout lies between them.',
    });
  }
}
