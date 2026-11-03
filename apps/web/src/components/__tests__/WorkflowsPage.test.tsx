// @vitest-environment happy-dom
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import WorkflowsPage from '../../pages/workflows';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

// _app registers it for every page; the "Edited" dates need it
dayjs.extend(relativeTime);

// The card's figures sit inside its link, so the link must render its children
vi.mock('next/link', () => ({
  default: ({children, href, ...props}: {children: React.ReactNode; href: string}) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('next-seo', () => ({NextSeo: () => null}));
vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));
vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));
vi.mock('../DashboardLayout', () => ({
  DashboardLayout: ({children}: {children: React.ReactNode}) => <div>{children}</div>,
}));

const workflow = (id: string, name: string, extra: object) => ({
  id,
  name,
  description: null,
  enabled: true,
  triggerType: 'EVENT',
  triggerConfig: {eventName: 'contact.subscribed'},
  allowReentry: true,
  projectId: 'p',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  _count: {steps: 3, executions: 9},
  ...extra,
});

const PAGES: Record<string, object> = {
  '/workflows?page=1&pageSize=20': {
    data: [
      workflow('busy', 'Busy', {contactCounts: {entered: 1234, inProgress: 7}}),
      // A response without the counts (an older API) reads as zero
      workflow('quiet', 'Quiet', {}),
    ],
    total: 2,
    page: 1,
    pageSize: 20,
    totalPages: 1,
  },
};

describe('WorkflowsPage', () => {
  let root: Root;
  let container: HTMLDivElement;

  const text = () => container.textContent ?? '';

  beforeEach(async () => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <SWRConfig
          value={{
            provider: () => new Map(),
            fetcher: async (url: string) => PAGES[url],
            dedupingInterval: 0,
          }}
        >
          <WorkflowsPage />
        </SWRConfig>,
      ),
    );
    await vi.waitFor(() => expect(text()).toContain('Busy'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  // Grouped as the machine's locale does it (es-ES writes 1234, en-US 1,234)
  const thousands = (1234).toLocaleString();

  it('shows contacts entered and in progress on the cards, not executions', () => {
    const [busy, quiet] = [...container.querySelectorAll('[data-card-link]')];

    expect(busy!.textContent).toContain(`${thousands}entered`);
    expect(busy!.textContent).toContain('7in progress');
    expect(quiet!.textContent).toContain('0entered');
    expect(quiet!.textContent).toContain('0in progress');
    expect(text()).not.toContain('executions');

    // Zero in progress is greyed out, so the busy workflows stand out
    const inProgress = (card: Element) =>
      [...card.querySelectorAll('strong')].find(s => s.nextElementSibling?.textContent === 'in progress')!;
    expect(inProgress(busy!).className).toContain('text-neutral-900');
    expect(inProgress(quiet!).className).toContain('text-neutral-500');
  });

  it('shows the same figures in their own columns in the table', async () => {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Table view"]')!.click();
    });

    const headers = [...container.querySelectorAll('th')].map(th => th.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Entered', 'In progress']));
    expect(headers).not.toContain('Executions');

    const busyRow = [...container.querySelectorAll('tr')].find(tr => tr.textContent?.includes('Busy'))!;
    const cells = [...busyRow.querySelectorAll('td')].map(td => td.textContent);
    expect(cells).toEqual(expect.arrayContaining([thousands, '7']));
  });
});
