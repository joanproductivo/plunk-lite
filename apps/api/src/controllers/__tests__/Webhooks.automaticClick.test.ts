import {afterEach, describe, expect, it, vi} from 'vitest';
import {clickSignals, isAutomaticClick} from '../Webhooks';

describe('isAutomaticClick', () => {
  it('leaves out only an exact "Likely"', () => {
    expect(isAutomaticClick({isBotEvent: 'Likely'}, true)).toBe(true);
    expect(isAutomaticClick({isBotEvent: 'Unlikely'}, true)).toBe(false);
    expect(isAutomaticClick(undefined, true)).toBe(false);
    expect(isAutomaticClick({}, true)).toBe(false);
    for (const isBotEvent of ['likely', 'Unknown', true, null]) {
      expect(isAutomaticClick({isBotEvent}, true)).toBe(false);
    }
  });

  it('counts every click when turned off', () => {
    expect(isAutomaticClick({isBotEvent: 'Likely'}, false)).toBe(false);
  });
});

describe('clickSignals', () => {
  const mail = {timestamp: '2026-11-01T10:00:00.000Z'};

  it('keeps the mark, the seconds since sending and the browser', () => {
    expect(
      clickSignals(
        {isBotEvent: 'Unlikely', timestamp: '2026-11-01T10:02:34.600Z', userAgent: 'Mozilla/5.0', ipAddress: '192.0.2.1'},
        mail,
      ),
    ).toEqual({isBotEvent: 'Unlikely', secondsSinceSent: 154.6, userAgent: 'Mozilla/5.0'});
  });

  it('leaves out whatever is missing or unexpected', () => {
    expect(clickSignals(undefined, undefined)).toEqual({});
    expect(clickSignals({isBotEvent: true, timestamp: 'never', userAgent: 42}, mail)).toEqual({});
    expect(clickSignals({timestamp: '2026-11-01T10:00:01.000Z'}, {})).toEqual({});
    expect(clickSignals({timestamp: '2026-11-01T10:00:01.000Z'}, null)).toEqual({});
  });

  it('cleans and cuts the browser, as it comes from outside', () => {
    const {userAgent} = clickSignals({userAgent: `a\n\u0000b${'c'.repeat(200)}`}, mail) as {userAgent: string};

    expect(userAgent.startsWith('abc')).toBe(true);
    expect(userAgent).toHaveLength(120);
  });
});

describe('IGNORE_AUTOMATIC_CLICKS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ['true', true],
    ['', true],
    ['false', false],
  ])('reads %j as %s', async (value, expected) => {
    vi.stubEnv('IGNORE_AUTOMATIC_CLICKS', value);
    vi.resetModules();

    const {IGNORE_AUTOMATIC_CLICKS} = await import('../../app/constants.js');

    expect(IGNORE_AUTOMATIC_CLICKS).toBe(expected);
  });
});
