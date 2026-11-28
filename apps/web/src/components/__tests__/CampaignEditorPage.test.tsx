// @vitest-environment happy-dom
import type {ReactNode} from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {toast} from 'sonner';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import CampaignDetailsPage from '../../pages/campaigns/[id]';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({
  query: {id: 'k1'} as {id: string},
  asPath: '/campaigns/k1',
  push: vi.fn(),
  events: {on: vi.fn(), off: vi.fn()},
}));

vi.mock('next/router', () => ({useRouter: () => route}));
// Radix's Select does not open in happy-dom: a native one with the same props stands in for it
vi.mock('@plunk/ui', async original => ({
  ...(await original<typeof import('@plunk/ui')>()),
  StickySaveBar: () => null,
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value ?? ''} onChange={event => onValueChange(event.target.value)}>
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({children}: {children: ReactNode}) => <>{children}</>,
  SelectItemWithDescription: ({value, title}: {value: string; title: string}) => <option value={value}>{title}</option>,
  SelectItem: ({value, children}: {value: string; children: ReactNode}) => <option value={value}>{children}</option>,
}));
vi.mock('next/link', () => ({default: () => null}));
vi.mock('next-seo', () => ({NextSeo: () => null}));
vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn(), info: vi.fn()}}));
vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));
vi.mock('../../lib/contexts/ActiveProjectProvider', () => ({useActiveProject: () => ({activeProject: {id: 'p'}})}));
vi.mock('../DashboardLayout', () => ({
  DashboardLayout: ({children}: {children: ReactNode}) => <div>{children}</div>,
}));
vi.mock('../EmailEditor', () => ({EmailEditor: () => null}));
vi.mock('../EmailSettings', () => ({EmailSettings: () => null}));

const CAMPAIGN = {
  id: 'k1',
  projectId: 'p',
  name: 'Reminder',
  description: '',
  subject: 'Your workshop',
  body: '<p>Soon</p>',
  from: 'news@example.com',
  fromName: null,
  replyTo: null,
  status: 'DRAFT',
  audienceType: 'ALL',
  segmentId: null,
  excludedSegmentIds: [],
  totalRecipients: 2,
};

const RESPONSES: Record<string, unknown> = {
  '/campaigns/k1': {data: {...CAMPAIGN, type: 'TRANSACTIONAL', optOutSegmentId: 's1'}},
  '/campaigns/k2': {data: {...CAMPAIGN, id: 'k2', type: 'MARKETING', optOutSegmentId: null}},
  '/campaigns/k1/audience': {data: {unsubscribed: 0}},
  '/campaigns/k2/audience': {data: {unsubscribed: 0}},
  '/segments': [
    {id: 's1', name: 'EXCLUIR', type: 'STATIC', memberCount: 1},
    {id: 's2', name: 'Workshop', type: 'STATIC', memberCount: 3},
  ],
};

/** Plunk Lite: the opt-out topic of a transactional campaign, in its draft editor */
describe('CampaignDetailsPage opt-out topic', () => {
  let root: Root;
  let container: HTMLDivElement;

  const app = () => (
    <SWRConfig value={{provider: () => new Map(), fetcher: async (url: string) => RESPONSES[url], dedupingInterval: 0}}>
      <CampaignDetailsPage />
    </SWRConfig>
  );

  const text = () => container.textContent ?? '';
  const typeButton = (label: string) =>
    [...container.querySelectorAll('button')].find(button => button.querySelector('span')?.textContent === label)!;
  const selectWith = (option: string) =>
    [...container.querySelectorAll('select')].find(select =>
      [...select.options].some(item => item.textContent === option),
    )!;
  const choose = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', {bubbles: true}));
    });
  };
  const save = async () => {
    vi.mocked(network.fetch).mockResolvedValue({});
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    });
  };

  const open = async (id: string) => {
    route.query = {id};
    await act(async () => root.render(app()));
    await vi.waitFor(() => expect(text()).toContain('Campaign type'));
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('is offered only on a transactional campaign', async () => {
    await open('k2');
    expect(text()).not.toContain('Opt-out topic');

    await act(async () => typeButton('Transactional').click());
    expect(text()).toContain('Opt-out topic');
  });

  it('shows the topic, and sends null when the type changes, warning first', async () => {
    await open('k1');
    await vi.waitFor(() => expect(text()).toContain('This campaign is not sent to its members'));
    expect(text()).toContain('EXCLUIR');
    expect(text()).toContain('except the notices footer of their opt-out topic');

    await act(async () => typeButton('Marketing').click());
    expect(text()).not.toContain('Opt-out topic');
    expect(text()).toContain('will get this campaign once you save');
    expect(text()).toContain('Choose how this campaign should be treated');

    await save();
    expect(network.fetch).toHaveBeenCalledWith(
      'PUT',
      '/campaigns/k1',
      expect.objectContaining({type: 'MARKETING', optOutSegmentId: null}),
    );
  });

  it('does not send the topic when it did not change', async () => {
    await open('k1');
    await vi.waitFor(() => expect(text()).toContain('EXCLUIR'));
    await choose(selectWith('Specific segment'), 'SEGMENT');
    await choose(selectWith('Workshop'), 's2');

    await save();
    const [, , body] = vi.mocked(network.fetch).mock.calls.find(([method]) => method === 'PUT')!;
    expect(body).toMatchObject({segmentId: 's2'});
    // Undefined, not null: null would remove the topic
    expect((body as {optOutSegmentId?: unknown}).optOutSegmentId).toBeUndefined();
  });

  it('drops the topic when its segment becomes the audience', async () => {
    await open('k1');
    await vi.waitFor(() => expect(text()).toContain('EXCLUIR'));
    await choose(selectWith('Specific segment'), 'SEGMENT');
    await choose(selectWith('Workshop'), 's1');

    expect(text()).toContain('will get this campaign once you save');
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('cannot be sent to its own opt-out segment'));

    await save();
    expect(network.fetch).toHaveBeenCalledWith(
      'PUT',
      '/campaigns/k1',
      expect.objectContaining({segmentId: 's1', optOutSegmentId: null}),
    );
  });
});
