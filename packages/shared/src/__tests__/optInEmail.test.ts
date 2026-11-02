import {describe, expect, it} from 'vitest';

import {SUPPORTED_LANGUAGES} from '../i18n/index.js';
import {
  BRAND_DEFAULTS,
  EMAIL_FONT_FAMILY,
  EMAIL_FONTS,
  isPlunkOptInText,
  optInEmail,
  plunkOptInText,
  renderTemplate,
  toOptInLogo,
  toOptInTexts,
} from '../template/index.js';

const valid = {subject: 'Confirm {projectName}', text: 'Hello.\n\nPlease confirm.', buttonText: 'Confirm'};

describe('toOptInTexts', () => {
  it('keeps valid texts by language and trims them', () => {
    const {texts, errors} = toOptInTexts({es: {...valid, text: '  Hola\r\n\r\n\r\n\r\nadiós  '}});
    expect(errors).toEqual([]);
    expect(texts.es).toEqual({...valid, text: 'Hola\n\nadiós'});
  });

  it.each([
    ['an unknown language', {xx: valid}, 'not a supported language'],
    ['an empty subject', {en: {...valid, subject: ''}}, 'subject'],
    ['a subject on two lines', {en: {...valid, subject: 'a\nb'}}, 'one line'],
    ['a Liquid tag', {en: {...valid, text: 'Hi {{ name }}'}}, 'template tags'],
    ['a Liquid block', {en: {...valid, subject: '{% if x %}'}}, 'template tags'],
    ['an invisible button', {en: {...valid, buttonText: '​​​'}}, 'button text'],
    ['characters that reorder text', {en: {...valid, text: 'a‮b'}}, 'reorder'],
  ])('refuses %s', (_, value, reason) => {
    const {texts, errors} = toOptInTexts(value);
    expect(Object.keys(texts)).toEqual([]);
    expect(errors[0]).toContain(reason);
  });
});

describe('optInEmail', () => {
  const url = 'https://app.example.com/confirm#token';

  it("uses Plunk's text in the contact's language when the project has none", () => {
    const {subject, body} = optInEmail({language: 'es', projectName: 'Vida', url});
    expect(subject).toBe('Confirma tu suscripción a Vida');
    expect(body).toContain('Gracias por apuntarte a los emails de Vida.');
    expect(body).toContain(`href="${url}"`);
    expect(body).toContain('Confirmar mi suscripción');
  });

  it("uses the project's own text in that language", () => {
    const {subject, body} = optInEmail({language: 'en', projectName: 'Vida', url, texts: {en: valid}});
    expect(subject).toBe('Confirm Vida');
    expect(body).toMatch(/<p style="text-align: center; color: #374151; font-size: 16px;[^"]*">Hello\.<\/p>/);
  });

  it('escapes the texts and keeps Liquid from reading the project name when the email is sent', () => {
    const {body} = optInEmail({language: 'en', projectName: '<b>{{ email }}</b>', url, texts: {en: valid}});
    expect(body).not.toContain('<b>');
    // Sending renders the body with the contact's data, which a form can write
    expect(renderTemplate(body, {email: 'attacker@example.com'})).not.toContain('attacker@example.com');
  });

  it('keeps Liquid from reading the project name in the subject too, wherever it joins the text', () => {
    for (const [projectName, own] of [
      ['{{ email }}', 'Confirm {projectName}'],
      // A name ending in `{` meets the text that follows it
      ['Acme {', '{projectName}{ email }}'],
    ]) {
      const {subject} = optInEmail({
        language: 'en',
        projectName: projectName!,
        url,
        texts: {en: {...valid, subject: own!}},
      });
      expect(renderTemplate(subject, {email: 'attacker@example.com'})).not.toContain('attacker@example.com');
    }
  });

  it("keeps the confirmation link out of SES's click tracking", () => {
    expect(optInEmail({language: 'en', projectName: 'Vida', url}).body).toMatch(/<a href="[^"]+" ses:no-track /);
  });
});

describe('toOptInLogo', () => {
  const url = 'https://files.example.com/logo.png';

  it('keeps an https address in one of the sizes, 160 px by default, and no address means no logo', () => {
    expect(toOptInLogo(` ${url} `, 240)).toEqual({logo: {url, width: 240}, errors: []});
    expect(toOptInLogo(url, null).logo).toEqual({url, width: 160});
    expect(toOptInLogo(null, null)).toEqual({logo: null, errors: []});
    expect(toOptInLogo('', 999)).toEqual({logo: null, errors: []});
  });

  it('keeps the formats every email client shows, whatever their case', () => {
    for (const name of ['logo.jpg', 'logo.JPEG', 'logo.gif', 'logo.webp?v=2']) {
      expect(toOptInLogo(`https://files.example.com/${name}`, 160).logo).not.toBeNull();
    }
  });

  it.each([
    ['http://files.example.com/logo.png', 160],
    ['javascript:alert(1)', 160],
    ['not a url', 160],
    ['https://files.example.com/{{ email }}.png', 160],
    ['https://files.example.com/logo.png?a={{ email }}', 160],
    ['https://user:secret@files.example.com/logo.png', 160],
    ['https://%7B%7Bemail%7D%7D.example.com/logo.png', 160],
    ['https://｛｛email｝｝.example.com/logo.png', 160],
    [`https://files.example.com/${'"'.repeat(1990)}.png`, 160],
    ['https://files.example.com/LOGO.SVG?v=1', 160],
    ['https://files.example.com/logo.avif', 160],
    ['https://files.example.com/logo', 160],
    ['https://files.example.com/logo.png/', 160],
    [`https://files.example.com/${'a'.repeat(2000)}.png`, 160],
    ['https://files.example.com/logo.png', 100],
    ['https://files.example.com/logo.png', '160'],
  ])('refuses %s at %s, with the reason', (address, width) => {
    const {logo, errors} = toOptInLogo(address, width);
    expect(logo).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });
});

it('toOptInLogo reads what it keeps the same way', () => {
  const {logo} = toOptInLogo('https://files.example.com/a b.png?x=%7B', 240);
  expect(toOptInLogo(logo!.url, logo!.width)).toEqual({logo, errors: []});
});

describe('optInEmail layout', () => {
  const url = 'https://app.example.com/confirm#token';
  const logo = {url: 'https://files.example.com/logo.png?a=1&b="2', width: 240};

  it('centres the text, the button and the note, with or without a logo', () => {
    const {body} = optInEmail({language: 'en', projectName: 'Vida', url});
    const paragraphs = body.match(/<p style="[^"]*"/g)!;
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    for (const paragraph of paragraphs) expect(paragraph).toContain('text-align: center');
    expect(body).not.toContain('<img');
  });

  it('puts the logo first, escaped, named after the project', () => {
    const {body} = optInEmail({language: 'en', projectName: '<b>{{ email }}</b>', url, logo});
    const img = /<img [^>]*>/.exec(body)![0];
    expect(img).toContain('src="https://files.example.com/logo.png?a=1&amp;b=&quot;2"');
    expect(img).toContain('width="240"');
    expect(img).not.toContain('<b>');
    expect(optInEmail({language: 'en', projectName: 'Vida', url, logo}).body).toContain('alt="Vida"');
    expect(body.indexOf('<img')).toBeLessThan(body.indexOf('<a href'));
    expect(renderTemplate(body, {email: 'attacker@example.com'})).not.toContain('attacker@example.com');
  });

  it('writes the font and size of campaigns and templates, or the font of the brand', () => {
    expect(optInEmail({language: 'en', projectName: 'Vida', url}).body).toContain(
      `font-size: 16px; line-height: 1.6; font-family: ${EMAIL_FONT_FAMILY};`,
    );
    const font = Object.keys(EMAIL_FONTS)[0] as keyof typeof EMAIL_FONTS;
    const {body} = optInEmail({language: 'en', projectName: 'Vida', url, brand: {...BRAND_DEFAULTS, font}});
    expect(body).toContain(`font-family: ${EMAIL_FONTS[font]};`);
  });

  it('gives a brand without a frame a white column of 600 px, whatever colour it kept', () => {
    const {body} = optInEmail({
      language: 'en',
      projectName: 'Vida',
      url,
      brand: {...BRAND_DEFAULTS, contentColor: '#000000'},
    });
    expect(body).toContain('max-width: 600px;');
    expect(body).toContain('background-color: #ffffff');
    expect(body).not.toContain('#000000');
  });

  it('gives a framed brand with no width of its own a column of 600 px, in its own colour', () => {
    const brand = {...BRAND_DEFAULTS, backgroundColor: '#eeeeee', contentColor: '#fafafa'};
    const {body} = optInEmail({language: 'en', projectName: 'Vida', url, brand});
    expect(body).toContain('max-width: 600px;');
    expect(body).toContain('background-color: #fafafa');
  });

  it("keeps a framed brand's width and colours", () => {
    const brand = {...BRAND_DEFAULTS, contentWidth: 560, contentColor: '#fafafa'};
    const {body} = optInEmail({language: 'en', projectName: 'Vida', url, brand});
    expect(body).toContain('max-width: 560px;');
    expect(body).toContain('background-color: #fafafa');
  });
});

describe('plunkOptInText', () => {
  it('gives a valid confirmation email in every language', () => {
    for (const {code} of SUPPORTED_LANGUAGES) {
      expect(toOptInTexts({[code]: plunkOptInText(code)}).errors).toEqual([]);
    }
  });
  it("tells Plunk's text from a project's own", () => {
    expect(isPlunkOptInText(plunkOptInText('es'), 'es')).toBe(true);
    expect(isPlunkOptInText({...plunkOptInText('es'), buttonText: 'Sí'}, 'es')).toBe(false);
  });
});
