import {type EmailBrand, toEmailBrand} from './brand.js';
import {detectCustomHtmlPatterns} from './emailDocument.js';
import {decodeDataEntities, escapeHtml} from './html.js';
import {decodeEntities} from './preprocess.js';

/**
 * What an email carries besides its content lives in comments at the very start of its body, so
 * it needs no column of its own and survives anywhere the body is copied: first its preview text
 * (preheader), then its brand, and in a rendered email the mark of visual editor content (see
 * markVisualContent).
 *
 * The preheader is kept HTML-escaped: a `>` cannot close the comment early, and the API can place
 * it in the email as it is. Liquid still renders inside it, so `{{ variables }}` work in the
 * preview text too. The brand only holds `key=value` pairs of letters, digits, `#` and `-`, so
 * nothing in it reads as Liquid or can close the comment.
 */
const PREHEADER_PATTERN = /^<!--plunk:preheader:([\s\S]*?)-->/;
const BRAND_PATTERN = /^<!--plunk:brand:([a-z0-9#=;-]*)-->/;

// The marker's keys, short so that every email carries few bytes
const MARKER_KEYS = {
  font: 'font',
  textColor: 'text',
  headingColor: 'heading',
  linkColor: 'link',
  backgroundColor: 'background',
  contentColor: 'content',
  contentWidth: 'width',
} as const satisfies Record<keyof EmailBrand, string>;

/** A brand as the text of its marker: `key=value` pairs, leaving out what is null. */
function brandToMarkerText(brand: EmailBrand): string {
  return (Object.keys(MARKER_KEYS) as (keyof EmailBrand)[])
    .filter(key => brand[key] !== null)
    .map(key => `${MARKER_KEYS[key]}=${brand[key]}`)
    .join(';');
}

/** The brand a marker's text describes; anything unknown or invalid takes the default. */
function markerTextToBrand(text: string): EmailBrand {
  const values = new Map(
    text.split(';').map(pair => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)] as const;
    }),
  );
  const data: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(MARKER_KEYS)) {
    if (values.has(name)) data[key] = values.get(name);
  }
  return toEmailBrand(data);
}

export interface EmailMarkers {
  /** Still HTML-escaped; empty for none. */
  preheader: string;
  /** null for an email written before brands, which keeps the look emails always had. */
  brand: EmailBrand | null;
  body: string;
}

/** Separates an email's preheader and brand from its content. */
export function splitEmailMarkers(value: string): EmailMarkers {
  let body = value;

  const preheader = PREHEADER_PATTERN.exec(body);
  if (preheader) body = body.slice(preheader[0].length);

  const brand = BRAND_PATTERN.exec(body);
  if (brand) body = body.slice(brand[0].length);

  return {
    preheader: preheader?.[1] ?? '',
    brand: brand ? markerTextToBrand(brand[1] ?? '') : null,
    body,
  };
}

/** An email's body with its preheader and brand in front, in that order. */
export function joinEmailMarkers({preheader, brand, body}: EmailMarkers): string {
  return [
    preheader ? `<!--plunk:preheader:${preheader}-->` : '',
    brand ? `<!--plunk:brand:${brandToMarkerText(brand)}-->` : '',
    body,
  ].join('');
}

/**
 * The stored preheader as the plain text an author typed, or as a reader sees it once rendered:
 * a body's outputs write braces as entities too.
 */
export function preheaderToText(preheader: string): string {
  // The data's own entities first: a `&#123;` the author typed is stored as `&amp;#123;`, and
  // stays as typed
  return decodeEntities(decodeDataEntities(preheader));
}

/** Plain text typed by an author as a stored preheader. Blank text means no preheader. */
export function textToPreheader(text: string): string {
  return text.trim() ? escapeHtml(text) : '';
}

/**
 * What the content of a rendered email starts with when its template was visual editor content.
 * Whether an email is custom HTML is decided on the template its author wrote: Liquid fills in a
 * contact's data, which could otherwise make the email read as custom HTML, sent unchecked and
 * without its brand. A template that prints HTML with `| raw` is still judged as rendered.
 */
const VISUAL_MARKER = '<!--plunk:visual-->';

// A `| raw` inside a Liquid output or tag, not in the text around them
const RAW_OUTPUT = /\{[{%][^}]*\|\s*raw\b/;

/** `rendered`, what `template` became, marked as visual editor content if its template was. */
export function markVisualContent(template: string, rendered: string): string {
  const {body} = splitEmailMarkers(template);
  // Already marked (the second render of an email), custom HTML, or HTML the data brings in,
  // through a `| raw` anywhere in the template, the preheader included
  if (body.startsWith(VISUAL_MARKER) || detectCustomHtmlPatterns(body) || RAW_OUTPUT.test(template)) {
    return rendered;
  }
  // In front of the content, leaving the preheader and brand as they were written
  const at = rendered.length - splitEmailMarkers(rendered).body.length;
  return `${rendered.slice(0, at)}${VISUAL_MARKER}${rendered.slice(at)}`;
}

/**
 * An email's content (its body without preheader and brand) without its mark, and whether it is
 * custom HTML: never when marked, else as its HTML reads.
 */
export function readEmailContent(body: string): {content: string; custom: boolean} {
  if (body.startsWith(VISUAL_MARKER)) {
    return {content: body.slice(VISUAL_MARKER.length), custom: false};
  }
  return {content: body, custom: detectCustomHtmlPatterns(body)};
}
