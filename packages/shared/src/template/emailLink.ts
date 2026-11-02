/**
 * Links of the email editor's blocks (buttons and images): which ones they may carry. The
 * dashboard checks them when writing and reading a block; the API checks them again when sending.
 */

/**
 * Whether a block may link to `href`: web, mail and phone links, in-page anchors, and links
 * built with Liquid (a variable such as `{{unsubscribeUrl}}` or a `{% if %}` that picks one).
 * Anything else, `javascript:` above all, is never written into a block.
 */
export function isSafeLinkHref(href: string | null | undefined): boolean {
  const value = (href ?? '').trim();
  return /^(https?:\/\/|mailto:|tel:|#|\{\{|\{%)/i.test(value);
}

/** What isValidLinkHref asks for, as the editor says it. */
export const LINK_HREF_HINT = 'Use an https://, mailto: or tel: link, a #anchor, or a {{variable}}, without spaces.';

/**
 * Whether `href`, as typed in the editor (a block's dialog or the link popover), may be saved:
 * safe, and without spaces outside Liquid tags, which would break the link (and read as custom
 * HTML attributes).
 */
export function isValidLinkHref(href: string): boolean {
  return isSafeLinkHref(href) && !/\s/.test(href.trim().replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, ''));
}
