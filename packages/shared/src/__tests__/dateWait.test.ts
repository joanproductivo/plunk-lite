import {describe, expect, it} from 'vitest';

import {dateWaitProblem, isDateWait, wallTimeToInstant, WorkflowStepConfigSchemas} from '../index.js';

const iso = (wall: string, tz: string) => wallTimeToInstant(wall, tz)?.toISOString() ?? null;

describe('wallTimeToInstant', () => {
  it('converts a wall time in a time zone to its instant', () => {
    expect(iso('2026-11-22T14:00', 'Europe/Madrid')).toBe('2026-11-22T13:00:00.000Z');
    expect(iso('2026-07-01T14:00', 'Europe/Madrid')).toBe('2026-07-01T12:00:00.000Z');
    expect(iso('2026-11-22T14:00', 'Asia/Kathmandu')).toBe('2026-11-22T08:15:00.000Z');
    expect(iso('2126-06-01T09:00', 'Pacific/Kiritimati')).toBe('2126-05-31T19:00:00.000Z');
  });

  it('moves a time skipped by a clock change forward', () => {
    expect(iso('2027-03-28T02:30', 'Europe/Madrid')).toBe('2027-03-28T01:30:00.000Z');
    expect(iso('2027-03-14T02:30', 'America/New_York')).toBe('2027-03-14T07:30:00.000Z');
    expect(iso('2027-09-05T00:30', 'America/Santiago')).toBe('2027-09-05T04:30:00.000Z');
    expect(iso('2027-03-14T00:30', 'America/Havana')).toBe('2027-03-14T05:30:00.000Z');
    expect(iso('2026-10-04T02:15', 'Australia/Lord_Howe')).toBe('2026-10-03T15:45:00.000Z');
  });

  it('takes the first of a time that happens twice', () => {
    expect(iso('2026-10-25T02:30', 'Europe/Madrid')).toBe('2026-10-25T00:30:00.000Z');
    expect(iso('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  });

  it('is null for a day or time that does not exist, or a bad format or zone', () => {
    expect(iso('2026-02-31T10:00', 'Europe/Madrid')).toBeNull();
    expect(iso('2026-11-22T24:00', 'Europe/Madrid')).toBeNull();
    expect(iso('2026-11-22 14:00', 'Europe/Madrid')).toBeNull();
    expect(iso('2026-11-22T14:00', 'Mars/Olympus')).toBeNull();
  });
});

describe('dateWaitProblem', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const ok = {until: '2026-11-22T14:00', timezone: 'Europe/Madrid'};

  it('accepts a valid date wait, also a past one', () => {
    expect(dateWaitProblem(ok, now)).toBeNull();
    expect(dateWaitProblem({...ok, ifLate: 'continue'}, now)).toBeNull();
    expect(dateWaitProblem({...ok, until: '2020-01-01T00:00'}, now)).toBeNull();
    expect(isDateWait(ok)).toBe(true);
  });

  it('names what is wrong', () => {
    expect(dateWaitProblem({...ok, until: '2026-02-31T10:00'}, now)).toMatch(/not a real day/);
    expect(dateWaitProblem({...ok, timezone: '+02:00'}, now)).toMatch(/not an offset/);
    expect(dateWaitProblem({...ok, timezone: 'Mars/Olympus'}, now)).toMatch(/Unknown time zone/);
    expect(dateWaitProblem({...ok, amount: 2, unit: 'days'}, now)).toMatch(/not both/);
    expect(dateWaitProblem({...ok, ifLate: 'later'}, now)).toMatch(/ifLate/);
    expect(dateWaitProblem({...ok, extra: 1}, now)).toMatch(/Unknown setting/);
    expect(dateWaitProblem({...ok, until: '2029-01-01T00:00'}, now)).toMatch(/two years/);
    expect(dateWaitProblem(null, now)).toMatch(/no date/);
  });

  it('only checks the two years when given the time', () => {
    expect(dateWaitProblem({...ok, until: '2029-01-01T00:00'})).toBeNull();
  });

  it('is never a date wait for a duration or any other JSON', () => {
    expect(isDateWait({amount: 2, unit: 'days'})).toBe(false);
    expect(isDateWait({})).toBe(false);
    expect(isDateWait('2026-11-22T14:00')).toBe(false);
    expect(isDateWait([])).toBe(false);
  });
});

describe('WorkflowStepConfigSchemas.delay', () => {
  it('takes either form, with skip by default', () => {
    expect(WorkflowStepConfigSchemas.delay.parse({amount: 24, unit: 'hours'})).toEqual({amount: 24, unit: 'hours'});
    expect(WorkflowStepConfigSchemas.delay.parse({until: '2026-11-22T14:00', timezone: 'Europe/Madrid'})).toEqual({
      until: '2026-11-22T14:00',
      timezone: 'Europe/Madrid',
      ifLate: 'skip',
    });
  });

  it('refuses a date wait that cannot be converted', () => {
    expect(
      WorkflowStepConfigSchemas.delay.safeParse({until: '2026-02-31T10:00', timezone: 'Europe/Madrid'}).success,
    ).toBe(false);
    expect(WorkflowStepConfigSchemas.delay.safeParse({until: '2026-11-22T14:00', timezone: 'Nowhere'}).success).toBe(
      false,
    );
    expect(WorkflowStepConfigSchemas.delay.safeParse({}).success).toBe(false);
  });
});
