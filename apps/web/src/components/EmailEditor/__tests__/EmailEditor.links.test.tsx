// @vitest-environment happy-dom
import type {Editor} from '@tiptap/core';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailEditor} from '../EmailEditor';

/**
 * StarterKit 3 bundles its own Link. The editor turns it off and keeps only its configured one:
 * with both, Tiptap warns about the duplicate and runs StarterKit's click handler, which opens
 * the link in a new tab whenever someone clicks it while editing.
 */
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../lib/contexts/ActiveProjectProvider', () => ({
  useActiveProject: () => ({activeProject: {id: 'project-1'}}),
}));
vi.mock('../../../lib/hooks/useContacts', () => ({
  useContactFields: () => ({fields: [], fieldDetails: []}),
  useContacts: () => ({contacts: []}),
  useSegmentContacts: () => ({contacts: []}),
}));
vi.mock('../../../lib/hooks/useConfig', () => ({useConfig: () => ({data: undefined})}));
vi.mock('../../../lib/hooks/useTemplateValidation', () => ({
  useTemplateValidation: () => null,
  useTemplateFieldWarnings: () => [],
}));

let root: Root;
let container: HTMLDivElement;

async function render(value: string) {
  await act(async () => {
    root.render(
      <SWRConfig value={{fetcher: () => Promise.resolve(null), provider: () => new Map(), dedupingInterval: 0}}>
        <EmailEditor value={value} onChange={() => undefined} subject="Hi" from="hi@example.com" />
      </SWRConfig>,
    );
  });
  // Tiptap creates its editor in an effect
  await act(async () => undefined);
}

const editor = () => (container.querySelector('.ProseMirror') as (HTMLElement & {editor?: Editor}) | null)?.editor;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('Links in the email editor', () => {
  it('loads a single link extension, without the duplicate warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await render('<p><a href="https://example.com">Example</a></p>');

    const links = editor()?.extensionManager.extensions.filter(e => e.name === 'link') ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]?.options.openOnClick).toBe(false);
    expect(warn.mock.calls.some(args => String(args[0]).includes('Duplicate extension names'))).toBe(false);
  });

  it('does not open a link clicked while editing', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await render('<p><a href="https://example.com">Example</a></p>');

    const anchor = container.querySelector('.ProseMirror a');
    expect(anchor).not.toBeNull();
    const view = editor()!.view;
    const pos = view.posAtDOM(anchor!.firstChild!, 1);
    const event = new MouseEvent('click', {bubbles: true, button: 0});
    Object.defineProperty(event, 'target', {value: anchor});
    view.someProp('handleClick', handle => handle(view, pos, event));

    expect(open).not.toHaveBeenCalled();
  });

  it('keeps rel="noopener noreferrer" on the links it writes', async () => {
    await render('<p><a href="https://example.com">Example</a></p>');
    expect(editor()?.getHTML()).toContain('rel="noopener noreferrer"');
  });
});
