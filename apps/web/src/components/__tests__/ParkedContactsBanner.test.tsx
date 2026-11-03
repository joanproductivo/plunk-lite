// @vitest-environment happy-dom
import type {ParkedGroup} from '@plunk/types';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {toast} from 'sonner';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import {ParkedContactsBanner} from '../ParkedContactsBanner';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));
vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));

const group = (overrides: Partial<ParkedGroup>): ParkedGroup => ({
  stepId: 's1',
  stepName: 'Welcome email',
  branch: null,
  branchExists: true,
  count: 3,
  unsubscribed: 0,
  canContinue: true,
  ...overrides,
});

describe('ParkedContactsBanner', () => {
  let root: Root;
  let container: HTMLDivElement;

  const render = async (props: Partial<React.ComponentProps<typeof ParkedContactsBanner>> = {}) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onContinued = vi.fn();
    await act(async () =>
      root.render(
        <ParkedContactsBanner
          workflowId="wf"
          enabled
          parked={[group({})]}
          validation={{valid: true, errors: []}}
          onContinued={onContinued}
          {...props}
        />,
      ),
    );
    return onContinued;
  };
  const continueButton = () =>
    [...container.querySelectorAll('button')].find(b => b.textContent?.startsWith('Continue'));

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('says who waits where, and who can continue', async () => {
    await render({
      parked: [
        group({count: 3}),
        group({stepId: 's2', stepName: 'Plan?', branch: 'no', count: 1, canContinue: false}),
        group({stepId: 's3', stepName: 'Tier', branch: 'gold', count: 2, canContinue: false, branchExists: false}),
      ],
    });

    const text = container.textContent ?? '';
    expect(text).toContain('6 contacts reached the end and are waiting for new steps');
    expect(text).toContain('3 contacts after "Welcome email": can continue now');
    expect(text).toContain('1 contact after "Plan?", "no" branch: add a step after it to continue');
    expect(text).toContain('2 contacts after "Tier", "gold" branch: that branch no longer exists');
    expect(continueButton()?.textContent).toBe('Continue 3 contacts');
  });

  it('shows nothing when nobody waits', async () => {
    await render({parked: []});

    expect(container.textContent).toBe('');
  });

  it('only lets them continue while the workflow is enabled', async () => {
    await render({enabled: false});

    expect(continueButton()?.disabled).toBe(true);
    expect(container.textContent).toContain('Enable the workflow to let them continue');
  });

  it('asks for the workflow to be fixed first', async () => {
    await render({validation: {valid: false, errors: ['"Email" step is missing an email template']}});

    await act(async () => continueButton()!.click());

    expect(toast.error).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Continue 3 contacts?');
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it('confirms with how many, and the unsubscribed, before letting them continue', async () => {
    vi.mocked(network.fetch).mockResolvedValue({continuable: 3, perRound: 200, everyMinutes: 2});
    const onContinued = await render({parked: [group({unsubscribed: 1})]});

    await act(async () => continueButton()!.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain('Continue 3 contacts?'));
    expect(document.body.textContent).toContain('1 of them is unsubscribed: marketing emails skip them.');

    const confirm = [...document.querySelectorAll('button')].find(b => b.textContent === 'Continue')!;
    await act(async () => confirm.click());

    await vi.waitFor(() => expect(onContinued).toHaveBeenCalled());
    expect(network.fetch).toHaveBeenCalledWith('POST', '/workflows/wf/parked/continue');
    expect(toast.success).toHaveBeenCalledWith('3 contacts are continuing');
  });
});
