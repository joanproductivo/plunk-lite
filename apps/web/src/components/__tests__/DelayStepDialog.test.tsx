// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {toast} from 'sonner';

import {network} from '../../lib/network';
import {DelayStepDialog} from '../workflow-steps/DelayStepDialog';
import {delayLabel} from '../workflow-steps/shared';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn(), warning: vi.fn()}}));
vi.mock('../../lib/network', () => ({network: {fetch: vi.fn(async () => ({}))}}));

const wall = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 16);

/** Plunk Lite: a delay that waits until a date and time in a time zone */
describe('DelayStepDialog - waiting until a date', () => {
  let root: Root;
  let container: HTMLDivElement;

  async function open(config: Record<string, unknown>, waiting = 0, steps?: unknown[]) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const step = {id: 'step', name: 'Until the live', type: 'DELAY', config};
    await act(async () =>
      root.render(
        <DelayStepDialog
          step={step as never}
          workflowId="wf"
          open
          onOpenChange={() => {}}
          onSuccess={() => {}}
          waiting={waiting}
          steps={steps as never}
        />,
      ),
    );
  }

  const input = () => document.querySelector<HTMLInputElement>('#editDateWaitUntil')!;
  const submit = () => act(async () => input().closest('form')!.requestSubmit());
  /** Type into the date input as a person would, through React's own value tracking */
  async function setDate(value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input(), value);
      input().dispatchEvent(new Event('input', {bubbles: true}));
    });
  }

  async function setSpread(minutes: number) {
    const select = document.querySelector<HTMLSelectElement>('#editDateWaitSpread')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, String(minutes));
      select.dispatchEvent(new Event('change', {bubbles: true}));
    });
  }
  const confirmButton = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Save changes');

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('shows a saved date wait and saves it as it is, with what to do when late', async () => {
    const config = {until: wall(86_400_000), timezone: 'UTC', ifLate: 'continue'};
    await open(config);

    expect(input().value).toBe(config.until);
    expect(document.querySelector<HTMLSelectElement>('#editDateWaitTimezone')!.value).toBe('UTC');
    expect(document.querySelector('[data-testid="dateWaitEquivalent"]')!.textContent).toMatch(/^That is /);
    await submit();

    expect(network.fetch).toHaveBeenCalledWith('PATCH', '/workflows/wf/steps/step', {name: 'Until the live', config});
  });

  it('does not save a wait whose date was cleared', async () => {
    await open({until: wall(86_400_000), timezone: 'UTC'});
    await setDate('');

    expect(document.querySelector('[data-testid="dateWaitEquivalent"]')).toBeNull();
    await submit();
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it('asks before moving the contacts waiting at it to a new date', async () => {
    await open({until: wall(86_400_000), timezone: 'UTC', ifLate: 'skip'}, 3);
    const later = wall(2 * 86_400_000);
    await setDate(later);

    await submit();
    expect(network.fetch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('3 contacts waiting here will move to the new date.');

    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save changes')!;
    await act(async () => confirm.click());
    expect(network.fetch).toHaveBeenCalledWith('PATCH', '/workflows/wf/steps/step', {
      name: 'Until the live',
      config: {until: later, timezone: 'UTC', ifLate: 'skip'},
    });
  });

  it('warns that they continue right away when the new date has passed', async () => {
    await open({until: wall(86_400_000), timezone: 'UTC'}, 1);
    await setDate(wall(-86_400_000));

    await submit();

    expect(document.body.textContent).toContain('1 contact waiting here will continue right away.');
  });

  it('saves a new date without asking when nobody waits', async () => {
    await open({until: wall(86_400_000), timezone: 'UTC'});
    await setDate(wall(2 * 86_400_000));

    await submit();

    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it('saves the spread chosen, and none for "Don\'t spread"', async () => {
    const config = {until: wall(86_400_000), timezone: 'UTC', ifLate: 'skip'};
    await open(config);
    await setSpread(240);
    expect(document.querySelector('[data-testid="dateWaitEquivalent"]')!.textContent).toMatch(
      /^Contacts leave between /,
    );
    expect(document.body.textContent).toMatch(/If a contact arrives after the start \(/);

    await submit();
    expect(network.fetch).toHaveBeenCalledWith('PATCH', '/workflows/wf/steps/step', {
      name: 'Until the live',
      config: {...config, spreadMinutes: 240},
    });

    vi.mocked(network.fetch).mockClear();
    await setSpread(0);
    await submit();
    expect(network.fetch).toHaveBeenCalledWith('PATCH', '/workflows/wf/steps/step', {name: 'Until the live', config});
  });

  it('keeps a saved spread, also one not in the list, and saves it without asking when nothing moves', async () => {
    const config = {until: wall(86_400_000), timezone: 'UTC', ifLate: 'skip', spreadMinutes: 90};
    await open(config, 3);

    expect(document.querySelector<HTMLSelectElement>('#editDateWaitSpread')!.value).toBe('90');
    await submit();

    expect(confirmButton()).toBeUndefined();
    expect(network.fetch).toHaveBeenCalledWith('PATCH', '/workflows/wf/steps/step', {name: 'Until the live', config});
  });

  it('says the contacts move to their new times when the spread changes', async () => {
    await open({until: wall(86_400_000), timezone: 'UTC', ifLate: 'skip'}, 3);
    await setSpread(120);

    await submit();

    expect(network.fetch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('3 contacts waiting here will move to their new times.');
  });

  it('says some continue now and the rest later inside a spread that has started, and warns when shortening it', async () => {
    const start = wall(-60 * 60_000);
    await open({until: start, timezone: 'UTC', ifLate: 'skip', spreadMinutes: 240}, 2);
    await setSpread(180);

    await submit();

    expect(document.body.textContent).toMatch(
      /2 contacts waiting here: those whose time has passed continue right away, the rest by /,
    );
    expect(document.body.textContent).toContain('shortening it lets everyone whose new time has passed go at once');
  });

  it('says they all continue now once the whole spread has passed', async () => {
    await open({until: wall(86_400_000), timezone: 'UTC', spreadMinutes: 60}, 1);
    await setDate(wall(-2 * 60 * 60_000));

    await submit();

    expect(document.body.textContent).toContain('1 contact waiting here will continue right away.');
  });

  it('refuses a spread that reaches the next date wait', async () => {
    const config = {until: wall(86_400_000), timezone: 'UTC', ifLate: 'skip'};
    const steps = [
      {id: 'step', type: 'DELAY', config, outgoingTransitions: [{toStepId: 'next'}]},
      {
        id: 'next',
        name: 'Next live',
        type: 'DELAY',
        config: {until: wall(86_400_000 + 3 * 60 * 60_000), timezone: 'UTC'},
      },
    ];
    await open(config, 0, steps);

    await setSpread(240);
    await submit();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('The spread reaches the next date wait ("Next live"'),
    );
    expect(network.fetch).not.toHaveBeenCalled();

    await setSpread(120);
    await submit();
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a new date that comes inside the spread of a date wait before it', async () => {
    const config = {until: wall(86_400_000 + 6 * 60 * 60_000), timezone: 'UTC', ifLate: 'skip'};
    const steps = [
      {
        id: 'before',
        name: 'Morning live',
        type: 'DELAY',
        config: {until: wall(86_400_000), timezone: 'UTC', spreadMinutes: 240},
        outgoingTransitions: [{toStepId: 'step'}],
      },
      {id: 'step', type: 'DELAY', config},
    ];
    await open(config, 0, steps);

    await setDate(wall(86_400_000 + 3 * 60 * 60_000));
    await submit();

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('The spread of "Morning live" reaches this date'));
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it('says nobody leaves earlier when a spread that has started grows', async () => {
    await open({until: wall(-60 * 60_000), timezone: 'UTC', ifLate: 'skip', spreadMinutes: 180}, 2);
    await setSpread(240);

    await submit();

    expect(document.body.textContent).toMatch(
      /2 contacts waiting here will move to later times, by .+; nobody leaves earlier\./,
    );
  });

  it('still saves a rename when the saved spread already reaches the next date wait', async () => {
    const config = {until: wall(86_400_000), timezone: 'UTC', ifLate: 'skip', spreadMinutes: 240};
    const steps = [
      {id: 'step', type: 'DELAY', config, outgoingTransitions: [{toStepId: 'next'}]},
      {id: 'next', type: 'DELAY', config: {until: wall(86_400_000 + 60 * 60_000), timezone: 'UTC'}},
    ];
    await open(config, 0, steps);

    await submit();

    expect(toast.error).not.toHaveBeenCalled();
    expect(network.fetch).toHaveBeenCalledWith('PATCH', '/workflows/wf/steps/step', {name: 'Until the live', config});
  });

  it('labels the node with the date as written, in its time zone, or with the duration', () => {
    expect(delayLabel({until: '2026-11-22T14:00', timezone: 'Europe/Madrid'})).toBe(
      'Wait until 22 Nov 2026, 14:00 (Europe/Madrid)',
    );
    expect(delayLabel({until: '2026-11-25T14:00', timezone: 'Europe/Madrid', spreadMinutes: 240})).toBe(
      'Wait until 25 Nov 2026, 14:00 (Europe/Madrid), spread over 4 h',
    );
    expect(delayLabel({until: '2026-11-25T14:00', timezone: 'UTC', spreadMinutes: 90})).toMatch(
      /, spread over 1 h 30 min$/,
    );
    expect(delayLabel({amount: 2, unit: 'days'})).toBe('Wait 2 days');
    expect(delayLabel({})).toBeNull();
  });
});
