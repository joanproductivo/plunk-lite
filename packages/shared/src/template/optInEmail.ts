import type {OptInText, OptInTexts} from '@plunk/types';

import {createTranslatorSync} from '../i18n/index.js';

import {BRAND_DEFAULTS, type EmailBrand, isFramedBrand} from './brand.js';
import {BUTTON_DEFAULTS, type ButtonStyle, buttonStyle} from './emailButton.js';
import {emailFontFamily} from './emailFonts.js';
import {EMAIL_DEFAULT_WIDTH, emailDocument} from './emailDocument.js';
import {escapeBraces, escapeHtml, neutralizeLiquid} from './html.js';
import {countOccurrences, isVisibleLabel, plainText, readTextsByLanguage} from './unsubscribeFooter.js';

/**
 * The double opt-in email (Plunk Lite): what a contact receives to confirm a sign-up, shared by
 * sending (OptInService) and the dashboard's preview, so both show the same email.
 */

/** Plunk's own confirmation email in `language` (English when it has none). */
export function plunkOptInText(language: string): OptInText {
  const translator = createTranslatorSync(language);
  return {
    subject: translator.t('email.optin.subject'),
    text: translator.t('email.optin.text'),
    buttonText: translator.t('email.optin.button'),
  };
}

const SUBJECT_MAX = 200;
const TEXT_MAX = 2000;
const LINES_MAX = 20;
const BUTTON_MIN = 3;
const BUTTON_MAX = 60;
const NAMES_MAX = 3;

// The reason a confirmation email cannot be kept, or null. Sending runs Liquid over the email with
// the contact's data, which a sign-up form lets anyone write, so the texts hold none of its syntax
function optInProblem({subject, text, buttonText}: OptInText): string | null {
  if (subject.length < 1 || subject.length > SUBJECT_MAX) return `the subject needs 1 to ${SUBJECT_MAX} characters`;
  if (/\n/.test(subject)) return 'the subject must be on one line';
  if (text.length < 1 || text.length > TEXT_MAX) return `the text needs 1 to ${TEXT_MAX} characters`;
  if (countOccurrences(text, '\n') >= LINES_MAX) return `the text can have at most ${LINES_MAX} lines`;
  if ([subject, text, buttonText].some(value => /\p{Bidi_Control}/u.test(value))) {
    return 'the texts cannot hold characters that reorder them';
  }
  if ([subject, text, buttonText].some(value => /\{\{|\{%/.test(value))) {
    return 'the texts cannot hold template tags ({{ or {%); use {projectName} for the project name';
  }
  if (countOccurrences(subject, '{projectName}') + countOccurrences(text, '{projectName}') > NAMES_MAX) {
    return `the texts can name the project at most ${NAMES_MAX} times`;
  }
  if (!isVisibleLabel(buttonText, BUTTON_MIN, BUTTON_MAX)) {
    return `the button text needs ${BUTTON_MIN} to ${BUTTON_MAX} visible letters or digits, on one line`;
  }
  return null;
}

/**
 * A project's confirmation emails from untrusted data, keeping the valid ones, with the reasons the
 * others were left out (the first few). Line breaks are made plain and runs of blank lines kept to one.
 */
export function toOptInTexts(value: unknown): {texts: OptInTexts; errors: string[]} {
  return readTextsByLanguage(
    value,
    fields => ({
      subject: plainText(fields.subject),
      text: plainText(fields.text),
      buttonText: plainText(fields.buttonText),
    }),
    optInProblem,
  );
}

/** The sizes the logo at the top of a confirmation email comes in, in px */
export const OPT_IN_LOGO_WIDTHS = [120, 160, 240, 320];
export const OPT_IN_LOGO_WIDTH_DEFAULT = 160;
export const OPT_IN_LOGO_URL_MAX = 2000;
const OPT_IN_LOGO_EXTENSION = /\.(jpe?g|png|gif|webp)$/i;

export interface OptInLogo {
  url: string;
  width: number;
}

/**
 * A project's logo from untrusted data, with the reasons it cannot be kept. The URL has no braces,
 * as sending runs Liquid over the email. What counts is the URL as kept: `new URL` leaves them as
 * they are in a query and decodes them in a host, and encoding makes it longer.
 */
export function toOptInLogo(url: unknown, width: unknown): {logo: OptInLogo | null; errors: string[]} {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return {logo: null, errors: []};

  const errors: string[] = [];
  let href = '';
  if (/[{}]/.test(raw)) {
    errors.push("the logo's address cannot hold braces");
  } else {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:') errors.push("the logo's address must start with https://");
      else if (parsed.username || parsed.password) errors.push("the logo's address cannot hold a user or password");
      // The formats every email client shows, as uploads are named: Gmail hides SVG, Outlook AVIF
      else if (!OPT_IN_LOGO_EXTENSION.test(parsed.pathname)) {
        errors.push("the logo's address must end in .jpg, .jpeg, .png, .gif or .webp");
      } else if (!/^[a-z0-9.-]+$/.test(parsed.hostname) || /[{}]/.test(parsed.href)) {
        errors.push("the logo's address has characters it cannot hold");
      } else if (parsed.href.length > OPT_IN_LOGO_URL_MAX) {
        errors.push(`the logo's address can have at most ${OPT_IN_LOGO_URL_MAX} characters`);
      } else href = parsed.href;
    } catch {
      errors.push("the logo's address is not a valid URL");
    }
  }

  const size = width ?? OPT_IN_LOGO_WIDTH_DEFAULT;
  if (typeof size !== 'number' || !OPT_IN_LOGO_WIDTHS.includes(size)) {
    errors.push(`the logo's width must be one of ${OPT_IN_LOGO_WIDTHS.join(', ')} px`);
  }
  return errors.length > 0 ? {logo: null, errors} : {logo: {url: href, width: size as number}, errors};
}

/** Whether `text` says just what Plunk's would in `language`, so it needs no text of its own */
export function isPlunkOptInText(text: OptInText, language: string): boolean {
  const plunk = plunkOptInText(language);
  return text.subject === plunk.subject && text.text === plunk.text && text.buttonText === plunk.buttonText;
}

// Escaped for HTML, with braces as entities: sending runs Liquid over the body, and a project name
// is not to be read as a template tag there
function escapeForBody(value: string): string {
  return escapeBraces(escapeHtml(value));
}

/**
 * The confirmation email for a contact in `language`: the project's own text in that language, or
 * else Plunk's, with the project's logo if it has one and the link to confirm as a button in the
 * project's brand, all centred.
 */
export function optInEmail(params: {
  language: string;
  projectName: string;
  url: string;
  texts?: OptInTexts;
  brand?: EmailBrand & {button?: ButtonStyle};
  logo?: OptInLogo | null;
}): {subject: string; body: string} {
  const own = params.texts && Object.hasOwn(params.texts, params.language) ? params.texts[params.language] : undefined;
  const {subject, text, buttonText} = own ?? plunkOptInText(params.language);
  const brand = params.brand ?? BRAND_DEFAULTS;
  // The font and size campaigns and templates have: this email takes no stylesheet, so they are written here
  const font = ` font-family: ${emailFontFamily(brand)};`;
  const name = escapeForBody(params.projectName);

  const paragraphs = text
    .split(/\n{2,}/)
    .map(paragraph => {
      const html = paragraph
        .split('{projectName}')
        .map(part => escapeForBody(part).replace(/\n/g, '<br>'))
        .join(name);
      return `<p style="text-align: center; color: ${brand.textColor}; font-size: 16px; line-height: 1.6;${font}">${html}</p>`;
    })
    .join('\n    ');
  // Never through SES's click tracking: its event would keep the link, which confirms the sign-up
  const button = `<p style="text-align: center; font-size: 16px;${font}"><a href="${escapeHtml(params.url)}" ses:no-track style="${buttonStyle(params.brand?.button ?? BUTTON_DEFAULTS)}">${escapeForBody(buttonText)}</a></p>`;
  const ignore = `<p style="text-align: center; color: #6b7280; font-size: 12px;${font}">${escapeForBody(createTranslatorSync(params.language).t('email.optin.ignore'))}</p>`;

  const logo = params.logo
    ? `<p style="text-align: center; margin: 0 0 24px; color: ${brand.textColor};${font}"><img src="${escapeHtml(params.logo.url)}" alt="${name}" width="${params.logo.width}" style="display: inline-block; width: ${params.logo.width}px; max-width: 100%; height: auto; border: 0;"></p>\n    `
    : '';
  // Centred text needs a column to read well. A brand without a frame keeps a content colour that
  // shows nowhere, so its column is white rather than bringing that colour back
  const column = isFramedBrand(brand)
    ? {...brand, contentWidth: brand.contentWidth ?? EMAIL_DEFAULT_WIDTH}
    : {...brand, contentColor: BRAND_DEFAULTS.contentColor, contentWidth: EMAIL_DEFAULT_WIDTH};

  return {
    // Sending runs Liquid over the subject too: no tag survives, however the project's name joins
    // the text around it (the texts hold none of their own)
    subject: neutralizeLiquid(subject.replaceAll('{projectName}', () => params.projectName)),
    body: emailDocument(`${logo}${paragraphs}\n    ${button}\n    ${ignore}`, column),
  };
}
