// @vitest-environment happy-dom
import {LINK_HREF_HINT} from '@plunk/shared';
import {Editor} from '@tiptap/core';
import {NodeSelection} from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {LinkPopover} from '../LinkPopover';
import {ResizableImage} from '../ResizableImage';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const FILE_URL = 'https://files.example.com/files/p/1-0123456789abcdef-guide.pdf';

// The file dialog's part is its own test's: here it only hands back a file
vi.mock('../FileDialog', () => ({
  FileDialog: ({open, onPick}: {open: boolean; onPick: (url: string, name: string) => void}) =>
    open ? (
      <button type="button" onClick={() => onPick(FILE_URL, 'guide.pdf')}>
        Pick guide
      </button>
    ) : null,
}));

let root: Root;
let container: HTMLDivElement;
let editor: Editor;

async function render(canUpload = true) {
  await act(async () => {
    root.render(<LinkPopover editor={editor as never} canUpload={canUpload} />);
  });
}

const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    b => b.textContent?.includes(text) || b.title === text,
  );

async function click(text: string) {
  await act(async () => {
    button(text)!.click();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  editor = new Editor({extensions: [StarterKit, ResizableImage], content: '<p>Read the guide</p>'});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  editor.destroy();
});

describe('LinkPopover', () => {
  it('links the selected text to a file', async () => {
    // "guide" in "Read the guide"
    editor.commands.setTextSelection({from: 10, to: 15});
    await render();

    await click('Link');
    await click('File…');
    await click('Pick guide');

    expect(editor.getHTML()).toContain(
      `<a target="_blank" rel="noopener noreferrer nofollow" href="${FILE_URL}">guide</a>`,
    );
  });

  it("inserts the file's name, linked and closed, apart from the word before it, when no text is selected", async () => {
    editor.commands.setTextSelection(15);
    await render();

    await click('Link');
    await click('File…');
    await click('Pick guide');
    editor.commands.insertContent(' and more');

    expect(editor.getText()).toBe('Read the guide guide.pdf and more');
    expect(editor.getHTML()).toContain(`href="${FILE_URL}">guide.pdf</a> and more`);
  });

  it('inserts no space at the start of a line or after one', async () => {
    editor.commands.setContent('<p></p>');
    editor.commands.setTextSelection(1);
    await render();

    await click('Link');
    await click('File…');
    await click('Pick guide');

    expect(editor.getText()).toBe('guide.pdf');
  });

  it('offers files only when storage is configured', async () => {
    await render(false);

    await click('Link');

    expect(button('File…')).toBeUndefined();
  });

  describe('with an image selected', () => {
    // What clicking the image in the editor does
    function selectImage() {
      editor.commands.setContent('<p>a</p><img src="x.png"><p>b</p>');
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 3)));
    }

    async function typeLink(url: string) {
      const input = container.querySelector('input')!;
      await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setValue.call(input, url);
        input.dispatchEvent(new Event('input', {bubbles: true}));
      });
    }

    it('links the image, not text, and keeps it selected', async () => {
      selectImage();
      await render();

      await click('Link');
      await typeLink('https://example.com/offer');
      await click('Add');

      expect(editor.getAttributes('image').href).toBe('https://example.com/offer');
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
      expect(editor.getHTML()).not.toContain('noopener');
    });

    it('shows the link to edit it, and removes it', async () => {
      selectImage();
      editor.commands.updateAttributes('image', {href: 'https://example.com/offer'});
      await render();

      expect(button('Link')!.dataset.active).toBe('true');
      await click('Link');
      expect(container.querySelector('input')!.value).toBe('https://example.com/offer');
      await typeLink('https://example.com/new');
      await click('Update');
      expect(editor.getAttributes('image').href).toBe('https://example.com/new');

      await click('Link');
      await click('Remove link');

      expect(editor.getAttributes('image').href).toBeNull();
    });

    it('links the image to a file', async () => {
      selectImage();
      await render();

      await click('Link');
      await click('File…');
      await click('Pick guide');

      expect(editor.getAttributes('image').href).toBe(FILE_URL);
      expect(editor.getText()).not.toContain('guide.pdf');
    });

    it('closes when the selection moves from the image to text, so its link never lands there', async () => {
      selectImage();
      await render();

      await click('Link');
      await typeLink('https://example.com/offer');
      // Clicking into the text after the image, as the toolbar re-renders on selection changes
      editor.commands.setTextSelection(6);
      await render();

      expect(container.querySelector('input')).toBeNull();
      expect(editor.getHTML()).not.toContain('example.com/offer');
    });

    it('asks for a full link rather than saving one a block may not have', async () => {
      selectImage();
      await render();

      await click('Link');
      await typeLink('www.example.com');
      await click('Add');

      expect(editor.getAttributes('image').href).toBeNull();
      expect(container.textContent).toContain(LINK_HREF_HINT);
    });
  });
});
