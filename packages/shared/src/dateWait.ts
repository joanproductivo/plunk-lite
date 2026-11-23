/**
 * Plunk Lite: a DELAY step that waits until a date and time in a time zone
 * ({until: 'YYYY-MM-DDTHH:mm', timezone, ifLate, spreadMinutes?}), next to the wait for a duration
 * ({amount, unit}). With `spreadMinutes`, each contact leaves at an instant of its own within that
 * many minutes after the date, instead of all at once.
 */

const DAY_MS = 86_400_000;
/** How far ahead a date wait may be, when it is saved */
const DATE_WAIT_MAX_AHEAD_MS = 731 * DAY_MS;
/** The longest spread of a date wait, in minutes */
export const DATE_WAIT_MAX_SPREAD_MINUTES = 1440;
/**
 * What a contact still needs after the end of a spread to reach the next date wait, besides the
 * waits in between: sending, and the workflow queue
 */
const SPREAD_SLACK_MS = 15 * 60_000;

export const DATE_WAIT_IF_LATE = ['skip', 'continue'] as const;
export type DateWaitIfLate = (typeof DATE_WAIT_IF_LATE)[number];

export interface DateWaitConfig {
  until: string;
  timezone: string;
  ifLate: DateWaitIfLate;
  /** Minutes over which the contacts leave, from the date on; missing or 0 is all at the date */
  spreadMinutes?: number;
}

/** A wall time as a date wait stores it: `YYYY-MM-DDTHH:mm`, without a time zone */
export const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_WAIT_KEYS = new Set(['until', 'timezone', 'ifLate', 'spreadMinutes']);

/** Whether `Intl` knows the time zone (IANA names, also offsets and aliases such as `CET`) */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: tz});
    return true;
  } catch {
    return false;
  }
}

/** The local time of an instant in a zone, read as if it were UTC */
function localAsUtc(tz: string, utcMs: number): number {
  const parts: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map(part => [part.type, part.value]),
  );
  const part = (type: string) => Number(parts[type]);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
}

function offsetAt(tz: string, utcMs: number): number {
  return localAsUtc(tz, utcMs) - utcMs;
}

/**
 * The instant a wall time (`YYYY-MM-DDTHH:mm`) stands for in a time zone, or null if the day or
 * time does not exist. A time skipped by a clock change moves forward to the next valid one; a
 * time that happens twice is the first. Tries the offsets of a day before and a day after, and
 * keeps the instant whose local time matches
 */
export function wallTimeToInstant(wall: string, timezone: string): Date | null {
  const match = WALL_TIME.exec(wall);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (hour > 23 || minute > 59) return null;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(asUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  if (!isValidTimezone(timezone)) return null;

  const before = offsetAt(timezone, asUtc - DAY_MS);
  const after = offsetAt(timezone, asUtc + DAY_MS);
  const hits = [...new Set([before, after])]
    .map(offset => asUtc - offset)
    .filter(instant => localAsUtc(timezone, instant) === asUtc)
    .sort((a, b) => a - b);
  return new Date(hits[0] ?? asUtc - before);
}

/**
 * What is wrong with a date wait's configuration, if anything. With `now`, it also refuses a date
 * more than two years ahead (only when saving: a saved date only gets closer)
 */
export function dateWaitProblem(config: unknown, now?: Date): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'The wait has no date';
  }
  const record = config as Record<string, unknown>;
  if ('amount' in record || 'unit' in record) {
    return 'A wait is either for a duration or until a date, not both';
  }
  const unknownKey = Object.keys(record).find(key => !DATE_WAIT_KEYS.has(key));
  if (unknownKey) {
    return `Unknown setting "${unknownKey}" in a wait until a date`;
  }
  if (typeof record.until !== 'string' || !WALL_TIME.test(record.until)) {
    return 'The date must look like 2026-11-22T14:00';
  }
  if (typeof record.timezone !== 'string' || !record.timezone.trim()) {
    return 'The wait needs a time zone';
  }
  if (/^[+-]/.test(record.timezone.trim())) {
    return 'Use a time zone name such as Europe/Madrid, not an offset';
  }
  if (!isValidTimezone(record.timezone)) {
    return `Unknown time zone "${record.timezone}"`;
  }
  if (record.ifLate !== undefined && !DATE_WAIT_IF_LATE.includes(record.ifLate as DateWaitIfLate)) {
    return 'ifLate must be "skip" or "continue"';
  }
  if (
    record.spreadMinutes !== undefined &&
    !(
      typeof record.spreadMinutes === 'number' &&
      Number.isInteger(record.spreadMinutes) &&
      record.spreadMinutes >= 0 &&
      record.spreadMinutes <= DATE_WAIT_MAX_SPREAD_MINUTES
    )
  ) {
    return `spreadMinutes must be a whole number of minutes from 0 to ${DATE_WAIT_MAX_SPREAD_MINUTES}`;
  }
  const at = wallTimeToInstant(record.until, record.timezone);
  if (!at) {
    return `${record.until} is not a real day and time`;
  }
  if (now && at.getTime() - now.getTime() > DATE_WAIT_MAX_AHEAD_MS) {
    return 'The date cannot be more than two years ahead';
  }
  return null;
}

/** Whether a step configuration is a valid wait until a date (tolerates any JSON); `ifLate` may be missing */
export function isDateWait(
  config: unknown,
): config is Omit<DateWaitConfig, 'ifLate'> & Partial<Pick<DateWaitConfig, 'ifLate'>> {
  return dateWaitProblem(config) === null;
}

/** Whether a step configuration is meant as a wait until a date (it has `until`), valid or not */
export function hasDateWaitShape(config: unknown): config is Record<string, unknown> & {until: unknown} {
  return !!config && typeof config === 'object' && !Array.isArray(config) && 'until' in config;
}

/** How long a date wait spreads its contacts over, in milliseconds (0 without a spread) */
export function dateWaitSpreadMs(config: {spreadMinutes?: unknown}): number {
  const minutes = config.spreadMinutes;
  return typeof minutes === 'number' && minutes > 0 ? minutes * 60_000 : 0;
}

/** A workflow step as the date wait helpers walk it */
export interface DateWaitRouteStep {
  id: string;
  type: string;
  name?: string | null;
  config: unknown;
  outgoingTransitions?: readonly {toStepId: string}[];
}

/** The first date wait on a route after a step, and what lies between them */
export interface NextDateWait {
  stepId: string;
  /** Its date, as it stands now */
  at: Date;
  ifLate: DateWaitIfLate;
  /** The longest, over the routes to it, of the waits for a duration and the time limits of waits for an event */
  travelMs: number;
  /** Whether a route to it has a wait for an event with no time limit */
  unbounded: boolean;
}

/** The units of a wait for a duration, as executeDelay in the API reads them */
const DURATION_UNIT_MS: Record<string, number> = {minutes: 60_000, hours: 3_600_000, days: DAY_MS};

/**
 * How long a step can hold a contact on its way to the next date wait (null: no limit). A webhook's
 * retries after a failure (up to hours) are not counted: they are the exception, not the route
 */
function holdMs(step: DateWaitRouteStep): number | null {
  const config = (step.config && typeof step.config === 'object' ? step.config : {}) as Record<string, unknown>;
  if (step.type === 'DELAY') {
    const unit = typeof config.unit === 'string' ? DURATION_UNIT_MS[config.unit] : undefined;
    return typeof config.amount === 'number' && unit ? config.amount * unit : 0;
  }
  if (step.type === 'WAIT_FOR_EVENT') {
    return typeof config.timeout === 'number' && config.timeout > 0 ? config.timeout * 1000 : null;
  }
  return 0;
}

function isDateWaitStep(step: DateWaitRouteStep): boolean {
  return step.type === 'DELAY' && hasDateWaitShape(step.config);
}

/**
 * The first date wait of every route that leaves `stepId` (any branch), with the longest a contact
 * can be held on the way. A route ends at a date wait that is not valid, without an entry (a run
 * fails there). Workflows have no loops (the API refuses them); one is cut where it closes
 */
export function nextDateWaitInstants(steps: readonly DateWaitRouteStep[], stepId: string): NextDateWait[] {
  const byId = new Map(steps.map(step => [step.id, step]));
  type Reach = Map<string, {travelMs: number; unbounded: boolean}>;
  const memo = new Map<string, Reach>();
  const walking = new Set<string>();

  // The date waits reachable after `id`, each with the longest hold on the way
  const reachAfter = (id: string): Reach => {
    const known = memo.get(id);
    if (known) return known;
    const reach: Reach = new Map();
    walking.add(id);
    for (const transition of byId.get(id)?.outgoingTransitions ?? []) {
      const next = byId.get(transition.toStepId);
      if (!next || walking.has(next.id)) continue;
      const found: Reach = isDateWaitStep(next)
        ? new Map([[next.id, {travelMs: 0, unbounded: false}]])
        : new Map(
            [...reachAfter(next.id)].map(([target, way]) => {
              const hold = holdMs(next);
              return [target, {travelMs: way.travelMs + (hold ?? 0), unbounded: way.unbounded || hold === null}];
            }),
          );
      for (const [target, way] of found) {
        const before = reach.get(target);
        reach.set(target, {
          travelMs: Math.max(before?.travelMs ?? 0, way.travelMs),
          unbounded: (before?.unbounded ?? false) || way.unbounded,
        });
      }
    }
    walking.delete(id);
    memo.set(id, reach);
    return reach;
  };

  return [...reachAfter(stepId)].flatMap(([target, way]) => {
    const config = byId.get(target)!.config;
    if (!isDateWait(config)) return [];
    const at = wallTimeToInstant(config.until, config.timezone)!;
    return [{stepId: target, at, ifLate: config.ifLate ?? 'skip', ...way}];
  });
}

/** A date wait that a spread reaches: some contacts would get there after its date */
export interface SpreadOverlap {
  stepId: string;
  at: Date;
  /**
   * `error`: late contacts skip that wait's email. `warning`: the next wait goes on when late, or a
   * wait for an event with no time limit lies between them
   */
  severity: 'error' | 'warning';
}

/**
 * The date wait after `stepId` that its spread (`config`, as it is or is about to be saved) reaches,
 * if any: one whose date comes before the end of the spread plus the waits in between plus 15
 * minutes. An error comes before a warning, and the earlier date first
 */
export function spreadOverlap(
  steps: readonly DateWaitRouteStep[],
  stepId: string,
  config: unknown,
): SpreadOverlap | null {
  if (!isDateWait(config)) return null;
  const spreadMs = dateWaitSpreadMs(config);
  const at = wallTimeToInstant(config.until, config.timezone);
  if (spreadMs === 0 || !at) return null;

  const overlaps = nextDateWaitInstants(steps, stepId).flatMap((next): SpreadOverlap[] => {
    const reaches = at.getTime() + spreadMs + next.travelMs + SPREAD_SLACK_MS > next.at.getTime();
    if (reaches && next.ifLate === 'skip') {
      return [{stepId: next.stepId, at: next.at, severity: 'error'}];
    }
    if (reaches || next.unbounded) {
      return [{stepId: next.stepId, at: next.at, severity: 'warning'}];
    }
    return [];
  });
  overlaps.sort(
    (a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning') || a.at.getTime() - b.at.getTime(),
  );
  return overlaps[0] ?? null;
}
