import type {DateWaitConfig, DateWaitIfLate} from '@plunk/shared';
import {dateWaitSpreadMs, wallTimeToInstant} from '@plunk/shared';
import {Input, Label, RadioGroup, RadioGroupItem} from '@plunk/ui';
import {useMemo} from 'react';

import {formatDateTimeLocal, getUserTimezone} from '../../lib/dateUtils';

import {spreadLabel} from './shared';

const IF_LATE_OPTIONS: {value: DateWaitIfLate; label: string; description: string}[] = [
  {
    value: 'skip',
    label: 'Skip to the next date',
    description:
      'Nothing between this wait and the next "until a date" wait runs: no emails, webhooks or contact updates. ' +
      'Conditions still pick the path, and an Exit step still ends the workflow. With no date wait ahead, ' +
      'the contact finishes the workflow (or waits at its end, if the workflow keeps contacts until an Exit step).',
  },
  {
    value: 'continue',
    label: 'Continue right away',
    description: 'The contact goes on to the next step at once, as if the wait had just ended.',
  },
];

/** Plunk Lite: the spreads to choose from, in minutes (0: all leave at the date) */
const SPREAD_OPTIONS = [0, 30, 60, 120, 180, 240, 360, 480, 720];

/** The time zones to choose from: every one the browser knows, UTC, and the one saved if missing */
function timezoneOptions(current: string): string[] {
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [getUserTimezone()];
  const all = new Set(['UTC', ...known]);
  if (current) {
    all.add(current);
  }
  return [...all].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}

/** A new wait until a date: tomorrow at 09:00, in the browser's time zone */
export function defaultDateWait(): DateWaitConfig {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return {until: formatDateTimeLocal(tomorrow), timezone: getUserTimezone(), ifLate: 'skip'};
}

/**
 * Plunk Lite: the date, the time zone, the spread, what happens to a contact who arrives late, and
 * the time it stands for here
 */
export function DateWaitFields({value, onChange}: {value: DateWaitConfig; onChange: (value: DateWaitConfig) => void}) {
  const zones = useMemo(() => timezoneOptions(value.timezone), [value.timezone]);
  const at = value.until ? wallTimeToInstant(value.until, value.timezone) : null;
  const browserZone = getUserTimezone();
  const spread = value.spreadMinutes ?? 0;
  // A spread saved through the API that is not in the list still shows
  const spreads = SPREAD_OPTIONS.includes(spread) ? SPREAD_OPTIONS : [...SPREAD_OPTIONS, spread].sort((a, b) => a - b);
  const when = at
    ? spread > 0
      ? `Contacts leave between ${formatHere(at)} and ${formatHere(new Date(at.getTime() + dateWaitSpreadMs(value)))}`
      : `That is ${formatHere(at)}`
    : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="editDateWaitUntil">Date and time</Label>
          <Input
            id="editDateWaitUntil"
            type="datetime-local"
            value={value.until}
            onChange={e => onChange({...value, until: e.target.value.slice(0, 16)})}
            required
            className="mt-1.5"
          />
        </div>
        <div>
          <Label htmlFor="editDateWaitTimezone">Time zone</Label>
          <select
            id="editDateWaitTimezone"
            value={value.timezone}
            onChange={e => onChange({...value, timezone: e.target.value})}
            className="mt-1.5 flex h-9 w-full rounded-md border border-neutral-200 bg-transparent px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {zones.map(zone => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <Label htmlFor="editDateWaitSpread">Spread sends over</Label>
        <select
          id="editDateWaitSpread"
          value={spread}
          onChange={e => onChange({...value, spreadMinutes: Number(e.target.value)})}
          className="mt-1.5 flex h-9 w-full rounded-md border border-neutral-200 bg-transparent px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {spreads.map(minutes => (
            <option key={minutes} value={minutes}>
              {minutes === 0 ? "Don't spread" : spreadLabel(minutes)}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-neutral-500">
          Each contact leaves at a time of its own within this window, instead of all at once.
        </p>
      </div>

      {when && (
        <p className="text-xs text-neutral-500" data-testid="dateWaitEquivalent">
          {value.timezone === browserZone ? `${when}, your time.` : `${when} in your time zone (${browserZone}).`}
        </p>
      )}

      <div className="space-y-2">
        <Label>
          {at && spread > 0
            ? `If a contact arrives after the start (${formatHere(at)})`
            : 'If a contact arrives after this date'}
        </Label>
        <RadioGroup
          value={value.ifLate}
          onValueChange={ifLate => onChange({...value, ifLate: ifLate as DateWaitIfLate})}
          className="gap-2"
        >
          {IF_LATE_OPTIONS.map(option => (
            <label
              key={option.value}
              htmlFor={`dateWaitIfLate-${option.value}`}
              className="flex items-start gap-3 rounded-md border border-neutral-200 p-3 cursor-pointer hover:bg-neutral-50"
            >
              <RadioGroupItem id={`dateWaitIfLate-${option.value}`} value={option.value} className="mt-0.5" />
              <div className="space-y-0.5">
                <div className="text-sm font-medium text-neutral-900">{option.label}</div>
                <div className="text-xs text-neutral-500">{option.description}</div>
              </div>
            </label>
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}

/** An instant as a date and time in the browser's time zone */
export function formatHere(at: Date): string {
  return new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(at);
}
