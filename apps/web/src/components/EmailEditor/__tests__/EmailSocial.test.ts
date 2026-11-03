// @vitest-environment happy-dom
import {detectCustomHtmlPatterns, socialBlockHtml, type SocialItem} from '@plunk/shared';
import {Editor} from '@tiptap/core';
import {NodeSelection} from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import {afterEach, describe, expect, it} from 'vitest';

import {EmailButton} from '../EmailButton';
import {EmailSocial} from '../EmailSocial';
import {EmailTextAlign} from '../EmailTextAlign';
import {ResizableImage} from '../ResizableImage';

/**
 * Parsing and serialising run through the extensions the editor loads, image and button included,
 * so these pin the HTML social links are saved, previewed and sent with.
 */
const ICON = 'https://files.example.com/p/1-0123456789abcdef-plunk-social-x-circle-111827.png';
const ITEMS: SocialItem[] = [
  {network: 'instagram', url: 'https://instagram.com/acme?a=1&b=2', icon: ICON},
  {network: 'email', url: 'mailto:hi@acme.com', icon: ICON},
];

let editor: Editor;

function createEditor(content: string) {
  editor = new Editor({
    extensions: [StarterKit, EmailTextAlign, ResizableImage, EmailButton, EmailSocial],
    content,
  });
}

function socialNode() {
  let found: {attrs: Record<string, unknown>; pos: number} | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'social') found = {attrs: node.attrs, pos};
  });
  return found as {attrs: Record<string, unknown>; pos: number} | null;
}

afterEach(() => {
  editor.destroy();
});

describe('EmailSocial', () => {
  it.each([
    ['left', socialBlockHtml(ITEMS, 'medium', null)],
    ['centred', socialBlockHtml(ITEMS, 'small', 'center')],
    ['right', socialBlockHtml(ITEMS, 'large', 'right')],
  ])('reads back the %s block it writes, as visual content', (_name, html) => {
    createEditor(`<p>a</p>${html}<p>b</p>`);

    expect(editor.getHTML()).toBe(`<p>a</p>${html}<p>b</p>`);
    expect(detectCustomHtmlPatterns(editor.getHTML())).toBe(false);
    expect(socialNode()!.attrs.items).toEqual(ITEMS);
  });

  it('takes the links and images itself, before the image and link blocks', () => {
    createEditor(socialBlockHtml(ITEMS, 'medium', null));

    const names: string[] = [];
    editor.state.doc.descendants(node => {
      names.push(node.type.name);
    });
    expect(names).not.toContain('image');
    expect(names[0]).toBe('social');
  });

  it('reads a size it does not offer as the closest one', () => {
    createEditor(socialBlockHtml(ITEMS, 'medium', null).replace(/"32"/g, '"38"'));

    expect(socialNode()!.attrs.size).toBe('large');
  });

  it('writes only items it may: links without Liquid or spaces, https icons', () => {
    createEditor('<p></p>');
    editor.commands.insertContent({
      type: 'social',
      attrs: {
        items: [
          ...ITEMS,
          {network: 'x', url: 'https://x.com/{{ a }}', icon: ICON},
          {network: 'tiktok', url: 'https://t.co', icon: 'data:x'},
        ],
        size: 'medium',
      },
    });

    expect(editor.getHTML()).toContain(socialBlockHtml(ITEMS, 'medium', null));
  });

  it('is aligned by the alignment buttons, as images and buttons are', () => {
    createEditor(`<p>a</p>${socialBlockHtml(ITEMS, 'medium', null)}`);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, socialNode()!.pos)));

    editor.commands.setTextAlign('center');
    expect(editor.getHTML()).toContain(socialBlockHtml(ITEMS, 'medium', 'center'));

    editor.commands.setTextAlign('left');
    expect(editor.getHTML()).toContain(socialBlockHtml(ITEMS, 'medium', null));
  });
});
