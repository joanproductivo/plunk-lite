/**
 * Plunk Lite: a DELAY step that waits until a date and time in a time zone
 * ({until: 'YYYY-MM-DDTHH:mm', timezone, ifLate}), next to the wait for a duration ({amount, unit})
 */

const DAY_MS = 86_400_000;
/** How far ahead a date wait may be, when it is saved */
const DATE_WAIT_MAX_AHEAD_MS = 731 * DAY_MS;

export const DATE_WAIT_IF_LATE = ['skip', 'continue'] as const;
export type DateWaitIfLate = (typeof DATE_WAIT_IF_LATE)[number];

export interface DateWaitConfig {
  until: string;
  timezone: string;
  ifLate: DateWaitIfLate;
}

/** A wall time as a date wait stores it: `YYYY-MM-DDTHH:mm`, without a time zone */
export const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_WAIT_KEYS = new Set(['until', 'timezone', 'ifLate']);

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
