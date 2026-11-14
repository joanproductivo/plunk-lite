// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import {DelayStepDialog} from '../workflow-steps/DelayStepDialog';
import {delayLabel} from '../workflow-steps/shared';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));
vi.mock('../../lib/network', () => ({network: {fetch: vi.fn(async () => ({}))}}));

const wall = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 16);

/** Plunk Lite: a delay that waits until a date and time in a time zone */
describe('DelayStepDialog - waiting until a date', () => {
  let root: Root;
  let container: HTMLDivElement;

  async function open(config: Record<string, unknown>, waiting = 0) {
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
    expect(document.body.textContent).toContain('3 contacts are waiting here and move to the new date.');

    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save new date')!;
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

    expect(document.body.textContent).toContain('1 contact is waiting here and continue right away.');
  });

  it('saves a new date without asking when nobody waits', async () => {
    await open({until: wall(86_400_000), timezone: 'UTC'});
    await setDate(wall(2 * 86_400_000));

    await submit();

    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it('labels the node with the date as written, in its time zone, or with the duration', () => {
    expect(delayLabel({until: '2026-11-22T14:00', timezone: 'Europe/Madrid'})).toBe(
      'Wait until 22 Nov 2026, 14:00 (Europe/Madrid)',
    );
    expect(delayLabel({amount: 2, unit: 'days'})).toBe('Wait 2 days');
    expect(delayLabel({})).toBeNull();
  });
});
