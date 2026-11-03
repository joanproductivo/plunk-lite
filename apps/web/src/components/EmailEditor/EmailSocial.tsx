import {
  SOCIAL_CLASS,
  SOCIAL_DEFAULT_SIZE,
  SOCIAL_GAP,
  SOCIAL_NETWORKS,
  SOCIAL_SIZES,
  type SocialItem,
  type SocialSize,
  socialNetworkNamed,
  socialSizeOf,
  validSocialItems,
} from '@plunk/shared';
import {Node} from '@tiptap/core';
import type {DOMOutputSpec} from '@tiptap/pm/model';
import {NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer} from '@tiptap/react';

import {blockAlignment} from './blockAlignment';
import {emitEditBlock} from './useBlockDialog';

export interface SocialAttrs {
  items: SocialItem[];
  size: SocialSize;
}

// The items a saved block holds: each link and its image, read back as written
function readItems(element: HTMLElement): SocialItem[] {
  const items = Array.from(element.children)
    .filter(child => child.matches('a'))
    .map(link => {
      const image = link.querySelector('img');
      const network = socialNetworkNamed(image?.getAttribute('alt') ?? '');
      return {network: network!, url: link.getAttribute('href') ?? '', icon: image?.getAttribute('src') ?? ''};
    });
  // Never drops one: a block with an item it would not keep is custom HTML (see hasForeignSocial)
  return validSocialItems(items.filter(item => item.network));
}

function SocialView({node, editor, getPos}: ReactNodeViewProps) {
  const attrs = node.attrs as SocialAttrs & {textAlign: string | null};
  const px = SOCIAL_SIZES[attrs.size];

  return (
    <NodeViewWrapper
      title="Double-click to edit"
      onDoubleClick={() => emitEditBlock(editor, getPos)}
      style={{textAlign: blockAlignment(attrs.textAlign) ?? 'left', margin: '1em 0', cursor: 'pointer'}}
    >
      {attrs.items.length === 0 ? (
        <span className="text-sm text-neutral-500">Social links: double-click to choose networks</span>
      ) : (
        // Images, not links: the editor is no place to follow them
        attrs.items.map(item => (
          // eslint-disable-next-line @next/next/no-img-element -- an icon in the project's storage
          <img
            key={item.network}
            src={item.icon}
            alt={SOCIAL_NETWORKS[item.network]}
            width={px}
            height={px}
            draggable={false}
            style={{display: 'inline-block', margin: `0 ${SOCIAL_GAP / 2}px`, verticalAlign: 'middle'}}
          />
        ))
      )}
    </NodeViewWrapper>
  );
}

/**
 * Social links (Plunk Lite): a row of the brand's network icons, each linking to its profile.
 * Saved as <p class="email-social"> holding a link to an image per network and nothing else (see
 * @plunk/shared emailSocial), its alignment on the paragraph as images and buttons have it (see
 * EmailTextAlign). Each email keeps the links and icons it was given: changing the brand later
 * leaves it as it is.
 */
export const EmailSocial = Node.create({
  name: 'social',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      items: {default: [], parseHTML: readItems, renderHTML: () => ({})},
      size: {
        default: SOCIAL_DEFAULT_SIZE,
        parseHTML: element =>
          socialSizeOf(Number.parseInt(element.querySelector('img')?.getAttribute('width') ?? '', 10) || 0),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    // Ahead of Paragraph's and the image and button blocks' `p` rules; a leaf, so what is inside
    // is read only through its attributes. Anything else with the class is custom HTML.
    return [{tag: `p.${SOCIAL_CLASS}`, priority: 60}];
  },

  renderHTML({node}) {
    const attrs = node.attrs as SocialAttrs & {textAlign: string | null};
    const px = String(SOCIAL_SIZES[attrs.size]);
    const alignment = blockAlignment(attrs.textAlign);
    const links: DOMOutputSpec[] = validSocialItems(attrs.items).map(item => [
      'a',
      {href: item.url},
      ['img', {src: item.icon, alt: SOCIAL_NETWORKS[item.network], width: px, height: px}],
    ]);

    return [
      'p',
      {class: SOCIAL_CLASS, ...(alignment ? {style: `text-align: ${alignment};`} : {})},
      ...links,
    ] as DOMOutputSpec;
  },

  addNodeView() {
    return ReactNodeViewRenderer(SocialView);
  },
});
