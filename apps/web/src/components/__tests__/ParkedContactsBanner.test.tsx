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
  branchName: null,
  branchExists: true,
  fallbackBranchName: null,
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
          pace={{perRound: 200, everyMinutes: 2}}
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
        group({stepId: 's2', stepName: 'Plan?', branch: 'no', branchName: 'No', count: 1, canContinue: false}),
        group({
          stepId: 's3',
          stepName: 'Tier',
          branch: 'a1b2c3d4',
          branchName: 'Gold',
          count: 2,
          canContinue: false,
          branchExists: false,
        }),
        group({stepId: 's4', stepName: null, count: 1, canContinue: false, branchExists: false}),
      ],
    });

    const text = container.textContent ?? '';
    expect(text).toContain('7 contacts reached the end and are waiting for new steps');
    expect(text).toContain('3 contacts after "Welcome email": can continue now');
    expect(text).toContain('1 contact after "Plan?", "No" branch: add a step after it to continue');
    expect(text).toContain('2 contacts after "Tier", "Gold" branch: that branch no longer exists');
    expect(text).toContain('1 contact after a deleted step: its step was deleted');
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
    expect(document.body.textContent).toContain('200 every 2 minutes');
    expect(document.body.textContent).toContain('1 of them is unsubscribed: marketing emails skip them.');

    const confirm = [...document.querySelectorAll('button')].find(b => b.textContent === 'Continue')!;
    await act(async () => confirm.click());

    await vi.waitFor(() => expect(onContinued).toHaveBeenCalled());
    expect(network.fetch).toHaveBeenCalledWith('POST', '/workflows/wf/parked/continue');
    expect(toast.success).toHaveBeenCalledWith('3 contacts are continuing');
    // One press at a time: no button until the rounds have moved them
    expect(continueButton()).toBeUndefined();
    expect(container.textContent).toContain('Continuing, 200 every 2 minutes');
  });

  it('says by which branch those on a removed branch go on', async () => {
    await render({
      parked: [
        group({
          stepName: 'Tier',
          branch: 'a1b2c3d4',
          branchName: 'a1b2c3d4',
          branchExists: false,
          fallbackBranchName: 'Default',
          canContinue: false,
        }),
      ],
    });

    expect(container.textContent).toContain(
      'that branch no longer exists, so they go by "Default"; connect it to continue',
    );
  });
});
