// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import TemplateEditorPage from '../../pages/templates/[id]';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({query: {id: 'a'} as {id: string}, push: vi.fn()}));

vi.mock('next/router', () => ({useRouter: () => route}));
vi.mock('@plunk/ui', async original => ({
  ...(await original<typeof import('@plunk/ui')>()),
  StickySaveBar: () => null,
}));
vi.mock('next/link', () => ({default: () => null}));
vi.mock('next-seo', () => ({NextSeo: () => null}));
vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));
vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));
vi.mock('../../lib/contexts/ActiveProjectProvider', () => ({useActiveProject: () => ({activeProject: {id: 'p'}})}));
vi.mock('../DashboardLayout', () => ({
  DashboardLayout: ({children}: {children: React.ReactNode}) => <div>{children}</div>,
}));
vi.mock('../EmailEditor', () => ({EmailEditor: () => null}));
vi.mock('../EmailSettings', () => ({
  EmailSettings: ({replyTo}: {replyTo: string}) => <output id="reply-to">{replyTo}</output>,
}));

const TEMPLATES: Record<string, object> = {
  a: {
    id: 'a',
    name: 'A',
    subject: 'Subject A',
    body: '<p>A</p>',
    from: 'a@example.com',
    replyTo: 'a@other.example.org',
  },
  b: {
    id: 'b',
    name: 'B',
    subject: 'Subject B',
    body: '<p>B</p>',
    from: 'b@example.com',
    replyTo: 'b@other.example.org',
  },
};

describe('TemplateEditorPage', () => {
  let root: Root;
  let container: HTMLDivElement;

  const app = () => (
    <SWRConfig
      value={{
        provider: () => new Map(),
        fetcher: async (url: string) => TEMPLATES[url.split('/').pop()!],
        dedupingInterval: 0,
      }}
    >
      <TemplateEditorPage />
    </SWRConfig>
  );

  const shownReplyTo = () => container.querySelector('#reply-to')?.textContent;

  beforeEach(async () => {
    route.query = {id: 'a'};
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(app()));
    await vi.waitFor(() => expect(shownReplyTo()).toBe('a@other.example.org'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('shows the second template after moving to it without a reload, and saves its own fields', async () => {
    route.query = {id: 'b'};
    await act(async () => root.render(app()));
    await vi.waitFor(() => expect(shownReplyTo()).toBe('b@other.example.org'));

    vi.mocked(network.fetch).mockResolvedValue({});
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    });

    expect(network.fetch).toHaveBeenCalledWith(
      'PATCH',
      '/templates/b',
      expect.objectContaining({name: 'B', from: 'b@example.com', replyTo: 'b@other.example.org'}),
    );
  });
});
