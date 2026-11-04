// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import {ConditionStepDialog} from '../workflow-steps/ConditionStepDialog';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));
vi.mock('../../lib/network', () => ({network: {fetch: vi.fn(async () => ({}))}}));

/** Plunk Lite: a date condition takes a day, as segments do, also when it was saved with a time */
describe('ConditionStepDialog - dates', () => {
  let root: Root;
  let container: HTMLDivElement;

  const fields = {
    fields: ['contact.createdAt'],
    typedFields: [{field: 'contact.createdAt', type: 'date', category: 'Contact Fields'}],
  };

  async function open(value: string) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const step = {
      id: 'step',
      name: 'Signed up recently',
      type: 'CONDITION',
      config: {field: 'contact.createdAt', operator: 'greaterThan', value},
      outgoingTransitions: [],
    };
    await act(async () =>
      root.render(
        <SWRConfig
          value={{
            provider: () => new Map(),
            fetcher: async (url: string) => (url.startsWith('/workflows/fields') ? fields : {triggerConfig: null}),
            dedupingInterval: 0,
          }}
        >
          <ConditionStepDialog step={step as never} workflowId="wf" open onOpenChange={() => {}} onSuccess={() => {}} />
        </SWRConfig>,
      ),
    );
    // The value input turns into a date input once the field types load
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#editConditionValue')?.type).toBe('date'));
    return document.querySelector<HTMLInputElement>('#editConditionValue')!;
  }

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('shows a value saved with a time by its day, and saves only the day', async () => {
    const input = await open('2026-11-04T10:30');
    expect(input.value).toBe('2026-11-04');

    await act(async () => input.closest('form')!.requestSubmit());

    expect(network.fetch).toHaveBeenCalledWith('PATCH', '/workflows/wf/steps/step', {
      name: 'Signed up recently',
      config: {field: 'contact.createdAt', operator: 'greaterThan', value: '2026-11-04'},
    });
  });
});
