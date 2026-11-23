import {describe, expect, it} from 'vitest';

import {
  dateWaitProblem,
  dateWaitSpreadMs,
  type DateWaitRouteStep,
  isDateWait,
  nextDateWaitInstants,
  spreadOverlap,
  wallTimeToInstant,
  WorkflowStepConfigSchemas,
} from '../index.js';

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

describe('spreadMinutes', () => {
  const ok = {until: '2026-11-25T14:00', timezone: 'Europe/Madrid'};

  it('takes a whole number of minutes from 0 to 1440, or none', () => {
    for (const spreadMinutes of [0, 1, 240, 1440, undefined]) {
      expect(dateWaitProblem({...ok, spreadMinutes})).toBeNull();
    }
    for (const spreadMinutes of [1441, -1, 1.5, '240', null, Number.NaN]) {
      expect(dateWaitProblem({...ok, spreadMinutes})).toMatch(/spreadMinutes/);
    }
  });

  it('goes through the schema, which refuses the same values', () => {
    expect(WorkflowStepConfigSchemas.delay.parse({...ok, spreadMinutes: 240})).toEqual({
      ...ok,
      ifLate: 'skip',
      spreadMinutes: 240,
    });
    for (const spreadMinutes of [1441, -1, 1.5, '240', null]) {
      expect(WorkflowStepConfigSchemas.delay.safeParse({...ok, spreadMinutes}).success).toBe(false);
    }
  });

  it('is 0 ms without a spread', () => {
    expect(dateWaitSpreadMs({})).toBe(0);
    expect(dateWaitSpreadMs({spreadMinutes: 0})).toBe(0);
    expect(dateWaitSpreadMs({spreadMinutes: 240})).toBe(4 * 3_600_000);
  });
});

describe('nextDateWaitInstants and spreadOverlap', () => {
  const wait = (id: string, until: string, extra: Record<string, unknown> = {}): DateWaitRouteStep => ({
    id,
    type: 'DELAY',
    config: {until, timezone: 'Europe/Madrid', ...extra},
  });
  const step = (id: string, type: string, config: unknown = {}): DateWaitRouteStep => ({id, type, config});
  const link = (steps: DateWaitRouteStep[], edges: [string, string][]): DateWaitRouteStep[] =>
    steps.map(s => ({
      ...s,
      outgoingTransitions: edges.filter(([from]) => from === s.id).map(([, toStepId]) => ({toStepId})),
    }));
  // 25-nov 14:00 Madrid is 13:00 UTC; the next one, the 26th at 14:00
  const first = {until: '2026-11-25T14:00', timezone: 'Europe/Madrid', ifLate: 'skip'};

  it('finds the first date wait of each branch, and none past it', () => {
    const steps = link(
      [
        wait('a', first.until),
        step('c', 'CONDITION'),
        step('m1', 'SEND_EMAIL'),
        wait('b', '2026-11-26T14:00'),
        wait('d', '2026-11-27T14:00', {ifLate: 'continue'}),
        wait('e', '2026-11-28T14:00'),
      ],
      [
        ['a', 'c'],
        ['c', 'm1'],
        ['c', 'd'],
        ['m1', 'b'],
        ['b', 'e'],
      ],
    );
    const found = nextDateWaitInstants(steps, 'a');
    expect(found.map(next => [next.stepId, next.at.toISOString(), next.ifLate])).toEqual([
      ['b', '2026-11-26T13:00:00.000Z', 'skip'],
      ['d', '2026-11-27T13:00:00.000Z', 'continue'],
    ]);
    expect(nextDateWaitInstants(steps, 'e')).toEqual([]);
  });

  it('counts the longest hold on the way: waits for a duration and time limits', () => {
    const steps = link(
      [
        wait('a', first.until),
        step('c', 'CONDITION'),
        step('d1', 'DELAY', {amount: 2, unit: 'hours'}),
        step('w', 'WAIT_FOR_EVENT', {eventName: 'x', timeout: 1800}),
        wait('b', '2026-11-26T14:00'),
      ],
      [
        ['a', 'c'],
        ['c', 'd1'],
        ['c', 'w'],
        ['d1', 'b'],
        ['w', 'b'],
      ],
    );
    expect(nextDateWaitInstants(steps, 'a')).toEqual([
      {stepId: 'b', at: new Date('2026-11-26T13:00:00Z'), ifLate: 'skip', travelMs: 2 * 3_600_000, unbounded: false},
    ]);
  });

  it('is no overlap without a spread, or when the next date is far enough', () => {
    const steps = link([wait('a', first.until), wait('b', '2026-11-26T14:00')], [['a', 'b']]);
    expect(spreadOverlap(steps, 'a', first)).toBeNull();
    expect(spreadOverlap(steps, 'a', {...first, spreadMinutes: 240})).toBeNull();
    expect(spreadOverlap(steps, 'a', {...first, spreadMinutes: 1440 - 15})).toBeNull();
    expect(spreadOverlap([wait('a', first.until)], 'a', {...first, spreadMinutes: 1440})).toBeNull();
  });

  it('is an error when the spread, plus 15 minutes, reaches a next wait that skips', () => {
    // 29-nov 14:00 and 18:45: 4 h 45 min apart
    const steps = link([wait('a', '2026-11-29T14:00'), wait('b', '2026-11-29T18:45')], [['a', 'b']]);
    const config = {...first, until: '2026-11-29T14:00'};
    expect(spreadOverlap(steps, 'a', {...config, spreadMinutes: 270})).toBeNull();
    // Ends just at the next wait, counting the 15 minutes
    expect(spreadOverlap(steps, 'a', {...config, spreadMinutes: 271})).toEqual({
      stepId: 'b',
      at: new Date('2026-11-29T17:45:00Z'),
      severity: 'error',
    });
  });

  it('counts a wait for a duration in between', () => {
    const steps = link(
      [wait('a', first.until), step('d1', 'DELAY', {amount: 20, unit: 'hours'}), wait('b', '2026-11-26T14:00')],
      [
        ['a', 'd1'],
        ['d1', 'b'],
      ],
    );
    expect(spreadOverlap(steps, 'a', {...first, spreadMinutes: 225})).toBeNull();
    expect(spreadOverlap(steps, 'a', {...first, spreadMinutes: 240})?.severity).toBe('error');
  });

  it('is a warning when the next wait goes on when late, or a wait for an event has no limit', () => {
    const toContinue = link(
      [wait('a', '2026-11-29T14:00'), wait('b', '2026-11-29T18:45', {ifLate: 'continue'})],
      [['a', 'b']],
    );
    expect(spreadOverlap(toContinue, 'a', {...first, until: '2026-11-29T14:00', spreadMinutes: 300})?.severity).toBe(
      'warning',
    );
    const unbounded = link(
      [wait('a', first.until), step('w', 'WAIT_FOR_EVENT', {eventName: 'x'}), wait('b', '2026-12-07T10:00')],
      [
        ['a', 'w'],
        ['w', 'b'],
      ],
    );
    expect(spreadOverlap(unbounded, 'a', {...first, spreadMinutes: 30})).toEqual({
      stepId: 'b',
      at: new Date('2026-12-07T09:00:00Z'),
      severity: 'warning',
    });
  });

  it('puts an error before a warning', () => {
    const steps = link(
      [
        wait('a', first.until),
        step('c', 'CONDITION'),
        wait('b', '2026-11-25T15:00', {ifLate: 'continue'}),
        wait('d', '2026-11-25T16:00'),
      ],
      [
        ['a', 'c'],
        ['c', 'b'],
        ['c', 'd'],
      ],
    );
    expect(spreadOverlap(steps, 'a', {...first, spreadMinutes: 240})).toMatchObject({stepId: 'd', severity: 'error'});
  });
});
