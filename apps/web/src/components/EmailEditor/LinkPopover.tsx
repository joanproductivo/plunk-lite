import {isValidLinkHref, LINK_HREF_HINT} from '@plunk/shared';
import {Button} from '@plunk/ui';
import {NodeSelection} from '@tiptap/pm/state';
import {type Editor} from '@tiptap/react';
import {FileText, Link} from 'lucide-react';
import {useState} from 'react';

import {FileDialog} from './FileDialog';

/**
 * The toolbar's link button and its popover: links the selected text, or the selected image, to a
 * URL, or, with storage configured, to a file uploaded for it.
 */
export function LinkPopover({editor, canUpload}: {editor: Editor; canUpload: boolean}) {
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [showFileDialog, setShowFileDialog] = useState(false);

  // An image, selected with a click, carries its link itself (see ResizableImage)
  const {selection} = editor.state;
  const image = selection instanceof NodeSelection && selection.node.type.name === 'image';
  const active = image ? !!editor.getAttributes('image').href : editor.isActive('link');

  const close = () => {
    setLinkUrl('');
    setInvalid(false);
    setShowLinkInput(false);
  };

  // Opened for an image or for text, the popover is for that: clicking from one to the other closes
  // it, rather than leaving the link typed for one to land on the other unchecked
  const [openedForImage, setOpenedForImage] = useState(image);
  if (openedForImage !== image) {
    setOpenedForImage(image);
    close();
  }

  /**
   * Links the selection to `href`. An existing link is updated whole; with nothing selected,
   * `text` (a file's name) is inserted already linked, as there is nothing else to link: apart
   * from the word before it, and closed, so what is typed next is not part of the link.
   */
  const applyLink = (href: string, text?: string) => {
    if (image) {
      // Only what a block may link to: the link goes out as it is, with no text to fall back on
      if (!isValidLinkHref(href)) {
        setInvalid(true);
        return;
      }
      editor.chain().focus().updateAttributes('image', {href: href.trim()}).run();
    } else if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').setLink({href}).run();
    } else if (editor.state.selection.empty && text) {
      const {$from} = editor.state.selection;
      const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
      editor
        .chain()
        .focus()
        .insertContent([
          ...(before && !/\s/.test(before) ? [{type: 'text', text: ' '}] : []),
          {type: 'text', text, marks: [{type: 'link', attrs: {href}}]},
        ])
        .unsetMark('link')
        .run();
    } else {
      editor.chain().focus().setLink({href}).run();
    }
    close();
  };

  const addLink = () => {
    if (linkUrl) applyLink(linkUrl);
  };

  const removeLink = () => {
    if (image) {
      editor.chain().focus().updateAttributes('image', {href: null}).run();
    } else {
      editor.chain().focus().unsetLink().run();
    }
    close();
  };

  const toggle = () => {
    setInvalid(false);
    if (active) {
      // Get the current link URL and show the input to edit it
      setLinkUrl(editor.getAttributes(image ? 'image' : 'link').href || '');
      setShowLinkInput(true);
    } else {
      setShowLinkInput(!showLinkInput);
      setLinkUrl('');
    }
  };

  return (
    <div className="relative pr-2 border-r border-neutral-200">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onMouseDown={e => e.preventDefault()}
        onClick={toggle}
        data-active={active}
        className="h-8 w-8 data-[active=true]:bg-neutral-200"
        title="Link"
      >
        <Link className="h-4 w-4" />
      </Button>
      {showLinkInput && (
        <div className="absolute top-10 left-0 bg-white border border-neutral-200 rounded-lg shadow-md p-2 z-50 min-w-max">
          <div className="flex gap-2 mb-2">
            <input
              type="url"
              value={linkUrl}
              onChange={e => {
                setLinkUrl(e.target.value);
                setInvalid(false);
              }}
              placeholder="https://example.com"
              className="px-2 py-1 text-sm border border-neutral-200 rounded w-64"
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  addLink();
                } else if (e.key === 'Escape') {
                  close();
                }
              }}
              autoFocus
            />
            <Button type="button" size="sm" onMouseDown={e => e.preventDefault()} onClick={addLink}>
              {active ? 'Update' : 'Add'}
            </Button>
          </div>
          {invalid && <p className="mb-2 max-w-80 text-xs text-red-700">{LINK_HREF_HINT}</p>}
          <div className="flex justify-end gap-2">
            {canUpload && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onMouseDown={e => e.preventDefault()}
                onClick={() => setShowFileDialog(true)}
              >
                <FileText className="h-4 w-4 mr-1" />
                File…
              </Button>
            )}
            {active && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onMouseDown={e => e.preventDefault()}
                onClick={removeLink}
              >
                Remove link
              </Button>
            )}
          </div>
        </div>
      )}
      <FileDialog open={showFileDialog} onOpenChange={setShowFileDialog} onPick={applyLink} />
    </div>
  );
}
