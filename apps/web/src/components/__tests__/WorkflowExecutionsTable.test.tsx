// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {WorkflowExecutionsTable} from '../WorkflowExecutionsTable';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));
vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));

describe('WorkflowExecutionsTable', () => {
  let root: Root;
  let container: HTMLDivElement;

  // The dialog renders in a portal, outside the container
  const openCancelAll = async (activeExecutionsCount: number) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <SWRConfig
          value={{
            provider: () => new Map(),
            fetcher: async () => ({executions: [], total: 0, page: 1, pageSize: 20, totalPages: 0}),
            dedupingInterval: 0,
          }}
        >
          <WorkflowExecutionsTable workflowId="wf" activeExecutionsCount={activeExecutionsCount} onChange={() => {}} />
        </SWRConfig>,
      ),
    );
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.startsWith('Cancel All Active'))!;
    await act(async () => button.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain('Cancel every active execution?'));
    return document.body.textContent ?? '';
  };

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('speaks of one execution and its contact when only one is active', async () => {
    const text = await openCancelAll(1);

    expect(text).toContain('Stops the execution running or waiting in this workflow.');
    expect(text).toContain("Its contact won't receive");
    expect(text).not.toContain('all 1');
  });

  it('speaks of executions and their contacts when several are active', async () => {
    const text = await openCancelAll(2);

    expect(text).toContain('Stops all 2 executions running or waiting in this workflow.');
    expect(text).toContain("Their contacts won't receive");
  });
});
