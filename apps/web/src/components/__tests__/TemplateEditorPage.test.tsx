// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import TemplateEditorPage from '../../pages/templates/[id]';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({
  query: {id: 'a'} as {id: string},
  push: vi.fn(),
  // Unsaved changes listen for leaving the page
  events: {on: vi.fn(), off: vi.fn()},
}));

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
  // Plunk Lite: opt-out topics
  c: {
    id: 'c',
    name: 'C',
    subject: 'Subject C',
    body: '<p>C</p>',
    from: 'c@example.com',
    replyTo: 'c@other.example.org',
    type: 'TRANSACTIONAL',
    optOutSegmentId: 's1',
  },
  d: {
    id: 'd',
    name: 'D',
    subject: 'Subject D',
    body: '<p><a href="{{optOutUrl}}">Stop</a></p>',
    from: 'd@example.com',
    replyTo: 'd@other.example.org',
    type: 'TRANSACTIONAL',
    optOutSegmentId: null,
  },
  // A topic left on a MARKETING template (two edits at once, or a type changed by an earlier image)
  e: {
    id: 'e',
    name: 'E',
    subject: 'Subject E',
    body: '<p>E</p>',
    from: 'e@example.com',
    replyTo: 'e@other.example.org',
    type: 'MARKETING',
    optOutSegmentId: 's1',
  },
  // A topic whose segment is gone (by SQL, or from an earlier image)
  f: {
    id: 'f',
    name: 'F',
    subject: 'Subject F',
    body: '<p>F</p>',
    from: 'f@example.com',
    replyTo: 'f@other.example.org',
    type: 'TRANSACTIONAL',
    optOutSegmentId: 'gone',
  },
  segments: [{id: 's1', name: 'EXCLUIR', type: 'STATIC'}] as unknown as object,
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

  // Plunk Lite: the opt-out topic of a transactional template
  describe('opt-out topic', () => {
    const open = async (id: string, replyTo: string) => {
      route.query = {id};
      await act(async () => root.render(app()));
      await vi.waitFor(() => expect(shownReplyTo()).toBe(replyTo));
    };
    const text = () => container.textContent ?? '';
    const typeButton = (label: string) =>
      [...container.querySelectorAll('button')].find(button => button.querySelector('span')?.textContent === label)!;

    it('is not offered outside transactional templates', () => {
      expect(text()).not.toContain('Opt-out topic');
    });

    it('shows the topic with its warning, and sends null when the type changes, warning first', async () => {
      await open('c', 'c@other.example.org');
      await vi.waitFor(() => expect(text()).toContain('EXCLUIR'));
      expect(text()).toContain('Opt-out topic');
      expect(text()).toContain('stop getting this template');
      expect(text()).toContain('except the notices footer of their opt-out topic');

      await act(async () => typeButton('Marketing').click());
      expect(text()).not.toContain('Opt-out topic');
      expect(text()).toContain('will get this template again once you save');

      vi.mocked(network.fetch).mockResolvedValue({});
      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
      });
      expect(network.fetch).toHaveBeenCalledWith(
        'PATCH',
        '/templates/c',
        expect.objectContaining({type: 'MARKETING', optOutSegmentId: null}),
      );
    });

    it('opens a template that is not transactional with a topic left on it as unchanged, without warning', async () => {
      await open('e', 'e@other.example.org');

      expect(text()).toContain('All changes saved');
      expect(text()).not.toContain('will get this template again');
    });

    it('warns that a template whose topic is gone is sent to no one', async () => {
      await open('f', 'f@other.example.org');
      await vi.waitFor(() =>
        expect(text()).toContain('This segment no longer exists, so this template is sent to no one'),
      );

      expect(container.querySelector('[aria-label="Remove the opt-out topic Deleted segment"]')).not.toBeNull();
      expect(text()).not.toContain('stop getting this template');
    });

    it('warns when removing the topic, and when {{optOutUrl}} has no topic to fill it', async () => {
      await open('c', 'c@other.example.org');
      await vi.waitFor(() => expect(text()).toContain('EXCLUIR'));
      await act(async () =>
        (container.querySelector('[aria-label^="Remove the opt-out topic"]') as HTMLElement).click(),
      );
      expect(text()).toContain('will get this template again once you save');

      await open('d', 'd@other.example.org');
      expect(text()).toContain('This link is empty without an opt-out topic');
    });
  });
});
