import {HttpException} from '../exceptions/index.js';

/**
 * Check if a value is a date string in YYYY-MM-DD format
 */
export function isDateString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // Match YYYY-MM-DD format (with optional time component)
  const dateRegex = /^\d{4}-\d{2}-\d{2}(T|$)/;
  if (!dateRegex.test(value)) return false;
  // Verify it's a valid date
  const date = new Date(value);
  return !isNaN(date.getTime());
}

/**
 * Get date range for a date string (start of day to start of next day in UTC)
 * @param value - Date string in YYYY-MM-DD format
 * @returns Object with startOfDay and startOfNextDay as ISO strings
 */
export function getDateRange(value: string): {startOfDay: string; startOfNextDay: string} {
  // Extract just the date part (YYYY-MM-DD)
  const dateStr = value.split('T')[0];
  const startOfDay = `${dateStr}T00:00:00.000Z`;

  if (!dateStr) {
    throw new HttpException(400, `Invalid date string: ${value}`);
  }

  // Calculate start of next day
  const nextDay = new Date(dateStr);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const startOfNextDay = nextDay.toISOString().split('T')[0] + 'T00:00:00.000Z';

  return {startOfDay, startOfNextDay};
}
