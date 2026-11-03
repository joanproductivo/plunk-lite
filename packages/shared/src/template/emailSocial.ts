/**
 * Social links (Plunk Lite): the project's networks, set once in its brand, and the editor's
 * block that places them in an email as a row of icons, each linking to its profile. The icons
 * are PNGs the dashboard draws in the brand's colour and uploads to the project's storage (email
 * clients do not show SVG). Saved as <p class="email-social"> holding only links to images, which
 * the dashboard writes and reads, and the API sends as a table every client keeps.
 */

import {closestOption} from './emailBlocks.js';
import {normalizeHexColor} from './emailButton.js';
import {isValidLinkHref} from './emailLink.js';
import {escapeHtml} from './html.js';

export const SOCIAL_NETWORKS = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  x: 'X',
  threads: 'Threads',
  bluesky: 'Bluesky',
  pinterest: 'Pinterest',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  spotify: 'Spotify',
  substack: 'Substack',
  email: 'Email',
  website: 'Website',
} as const;

export type SocialNetwork = keyof typeof SOCIAL_NETWORKS;

/** The icon alone in the brand's colour, or white on a circle or a rounded square of it. */
export type SocialShape = 'plain' | 'circle' | 'square';

export const SOCIAL_SHAPES: readonly SocialShape[] = ['plain', 'circle', 'square'];

export interface SocialLink {
  network: SocialNetwork;
  url: string;
}

export interface SocialSettings {
  /** In the order they are shown, one per network. */
  links: SocialLink[];
  shape: SocialShape;
  color: string;
  /** The uploaded icon of each linked network, drawn in the current shape and colour. */
  icons: Partial<Record<SocialNetwork, string>>;
}

// A filled shape reads on light and dark backgrounds alike
export const SOCIAL_DEFAULTS: SocialSettings = {links: [], shape: 'circle', color: '#111827', icons: {}};

const URL_MAX = 2048;

/**
 * Whether `url` may be a network's link: an https:// address (a mailto: one for email) that the
 * editor would take, without spaces, Liquid or anything that could close an attribute. Brand
 * links are fixed text, so nothing in them is ever read as a template or as custom HTML.
 */
export function isValidSocialUrl(network: SocialNetwork, url: string): boolean {
  const scheme = network === 'email' ? /^mailto:[^@\s]+@/i : /^https:\/\/[^/\s?#]/i;
  return url.length <= URL_MAX && scheme.test(url) && isValidLinkHref(url) && !/[\s{}"'<>\\`]/.test(url);
}

// Hosts a dashboard runs on locally, whose storage serves plain http
const LOCAL_HOST = /^http:\/\/(localhost|127\.0\.0\.1|[a-z0-9-]+\.localhost)(:\d+)?\//i;

// Whether `src` may be an icon's image: an https:// address, or plain http on a local host
function isValidSocialIcon(src: string): boolean {
  return (
    src.length <= URL_MAX && (/^https:\/\/[^/\s?#]/i.test(src) || LOCAL_HOST.test(src)) && !/[\s"'<>\\`{}]/.test(src)
  );
}

const isNetwork = (value: unknown): value is SocialNetwork =>
  typeof value === 'string' && Object.hasOwn(SOCIAL_NETWORKS, value);

/**
 * Social settings from untrusted data (a request, a stored row), keeping only known networks,
 * valid links, one per network, and icons of linked networks; the rest takes the default.
 */
export function toSocialSettings(value: unknown): SocialSettings {
  const data = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;

  const links: SocialLink[] = [];
  for (const link of Array.isArray(data.links) ? data.links : []) {
    const {network, url} = (link && typeof link === 'object' ? link : {}) as Record<string, unknown>;
    if (!isNetwork(network) || typeof url !== 'string' || links.some(known => known.network === network)) continue;
    const trimmed = url.trim();
    if (isValidSocialUrl(network, trimmed)) links.push({network, url: trimmed});
  }

  const iconData = (data.icons && typeof data.icons === 'object' ? data.icons : {}) as Record<string, unknown>;
  const icons: Partial<Record<SocialNetwork, string>> = {};
  for (const {network} of links) {
    const src = iconData[network];
    if (typeof src === 'string' && isValidSocialIcon(src)) icons[network] = src;
  }

  return {
    links,
    shape: SOCIAL_SHAPES.includes(data.shape as SocialShape) ? (data.shape as SocialShape) : SOCIAL_DEFAULTS.shape,
    color: normalizeHexColor(typeof data.color === 'string' ? data.color : '') ?? SOCIAL_DEFAULTS.color,
    icons,
  };
}

/**
 * The name an icon is uploaded under, which the gallery of uploaded images leaves out (see the
 * API's listUploads). At most 40 characters, as upload names are kept (slugify).
 */
export function socialIconName(network: SocialNetwork, shape: SocialShape, color: string): string {
  return `${SOCIAL_ICON_PREFIX}${network}-${shape}-${color.replace('#', '')}`;
}

export const SOCIAL_ICON_PREFIX = 'plunk-social-';

export type SocialSize = 'small' | 'medium' | 'large';

/** An icon's width and height, in px. */
export const SOCIAL_SIZES: Record<SocialSize, number> = {small: 24, medium: 32, large: 40};

export const SOCIAL_DEFAULT_SIZE: SocialSize = 'medium';

/** Space between two icons, in px: half on each side of every icon. */
export const SOCIAL_GAP = 12;

export const SOCIAL_CLASS = 'email-social';

/** One icon of a block: where it links, and the image it shows. */
export interface SocialItem {
  network: SocialNetwork;
  url: string;
  icon: string;
}

/** The block's items that may be written: valid links and icons, one per network. */
export function validSocialItems(items: readonly SocialItem[]): SocialItem[] {
  return items.filter(
    (item, index) =>
      isNetwork(item.network) &&
      items.findIndex(other => other.network === item.network) === index &&
      isValidSocialUrl(item.network, item.url) &&
      isValidSocialIcon(item.icon),
  );
}

/**
 * A block as it is saved: <p class="email-social"> holding a link to an image per item, and
 * nothing else (see hasForeignSocial), its alignment on the paragraph as other blocks have it.
 */
export function socialBlockHtml(items: readonly SocialItem[], size: SocialSize, align: 'center' | 'right' | null) {
  const px = SOCIAL_SIZES[size];
  const links = validSocialItems(items)
    .map(
      item =>
        `<a href="${escapeHtml(item.url)}"><img src="${escapeHtml(item.icon)}" alt="${SOCIAL_NETWORKS[item.network]}" width="${px}" height="${px}"></a>`,
    )
    .join('');
  return `<p class="${SOCIAL_CLASS}"${align ? ` style="text-align: ${align};"` : ''}>${links}</p>`;
}

/** The size whose icons are closest to `width` px wide. */
export const socialSizeOf = (width: number): SocialSize => closestOption(SOCIAL_SIZES, width);

/** The network an icon's alt text names, as blocks write it, or null. */
export function socialNetworkNamed(alt: string): SocialNetwork | null {
  return (Object.keys(SOCIAL_NETWORKS) as SocialNetwork[]).find(network => SOCIAL_NETWORKS[network] === alt) ?? null;
}

// The paragraph's own attributes as the editor writes them
const SOCIAL_TAG = /^\s+class="email-social"(\s+style="text-align: (center|right);?")?\s*$/;
// One link and its image, as the editor writes them, attributes in double quotes
const SOCIAL_LINK = /^<a href="([^"<>]*)"><img src="([^"<>]*)" alt="([^"<>]*)" width="\d{1,3}" height="\d{1,3}"><\/a>$/;
// Each class attribute of a tag, however quoted. Each alternative stops at its own delimiter, so
// it never backtracks over a long attribute
const CLASS_ATTRIBUTE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

// Where a tag ends: its first `>` outside quoted attribute values, or -1
function tagEndOf(text: string): number {
  let quote = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return at;
    }
  }
  return -1;
}

// A link's attribute as written: only the `&amp;` escapeHtml writes; any other entity is foreign
const attributeText = (value: string) => (/&(?!amp;)/.test(value) ? null : value.replace(/&amp;/g, '&'));

/**
 * Whether a `p.email-social` is not one the editor writes in full: anything but links to images in
 * it (text, Liquid, other tags or attributes), or an item the block does not keep (an unknown
 * network, a link or icon it would not write, a network twice), would be dropped by the visual
 * editor, so it stays custom HTML. A linear scan, as the other block checks: the body may carry
 * contact data.
 */
export function hasForeignSocial(html: string): boolean {
  const paragraphs = html.split(/<p\b/i);
  for (let i = 1; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i]!;
    const tagEnd = tagEndOf(paragraph);
    // An unclosed quote: how a browser reads the rest is anyone's guess
    if (tagEnd < 0) {
      if (paragraph.toLowerCase().includes(SOCIAL_CLASS)) return true;
      continue;
    }
    const tag = paragraph.slice(0, tagEnd);
    const classes = [...tag.matchAll(CLASS_ATTRIBUTE)].flatMap(match =>
      (match[1] ?? match[2] ?? match[3] ?? '').split(/\s+/),
    );
    if (!classes.includes(SOCIAL_CLASS)) continue;
    if (!SOCIAL_TAG.test(tag)) return true;

    const content = paragraph.slice(tagEnd + 1);
    const end = content.search(/<\/p>/i);
    if (end < 0) return true;
    // No lookbehind to split on: older Safari, which the dashboard supports, has none
    const links = content.slice(0, end).split(/<\/a>/i);
    // Spaces and line breaks between links (from the HTML editor) hold nothing the editor drops
    if (links.pop()!.trim() !== '') return true;
    const items: SocialItem[] = [];
    for (const link of links) {
      const parts = SOCIAL_LINK.exec(`${link.trim()}</a>`);
      const url = parts && attributeText(parts[1]!);
      const icon = parts && attributeText(parts[2]!);
      const network = parts && socialNetworkNamed(parts[3]!);
      if (url === null || icon === null || network === null) return true;
      items.push({network, url, icon});
    }
    if (validSocialItems(items).length !== items.length) return true;
  }
  return false;
}
