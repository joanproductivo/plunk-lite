import {describe, expect, it} from 'vitest';

import {slugify} from '../slug.js';
import {
  detectCustomHtmlPatterns,
  emailProseCss,
  SOCIAL_DEFAULTS,
  SOCIAL_NETWORKS,
  SOCIAL_SHAPES,
  socialBlockHtml,
  socialIconName,
  socialSizeOf,
  toSocialSettings,
  type SocialNetwork,
} from '../template/index.js';

const ICON = 'https://files.example.com/uploads/p/1-abc-plunk-social-instagram-circle-111827.png';

describe('toSocialSettings', () => {
  it('keeps known networks with valid links, once each, in order', () => {
    expect(
      toSocialSettings({
        links: [
          {network: 'instagram', url: ' https://instagram.com/plunk '},
          {network: 'email', url: 'mailto:hi@example.com'},
          {network: 'instagram', url: 'https://instagram.com/other'},
          {network: 'myspace', url: 'https://myspace.com/x'},
        ],
        shape: 'square',
        color: '#ABC',
      }),
    ).toEqual({
      links: [
        {network: 'instagram', url: 'https://instagram.com/plunk'},
        {network: 'email', url: 'mailto:hi@example.com'},
      ],
      shape: 'square',
      color: '#aabbcc',
      icons: {},
    });
  });

  it('refuses links with spaces, Liquid, quotes or another scheme', () => {
    const urls = [
      'https://a.com/x role=y',
      'https://a.com/{{ name }}',
      'https://a.com/{% if x %}',
      'https://a.com/"onmouseover',
      "https://a.com/'x",
      'https://a.com/<b>',
      'http://a.com/x',
      'javascript:alert(1)',
      'mailto:hi@example.com',
      '#anchor',
    ];
    for (const url of urls) {
      expect(toSocialSettings({links: [{network: 'facebook', url}]}).links).toEqual([]);
    }
    // Email takes only mailto:
    expect(toSocialSettings({links: [{network: 'email', url: 'https://a.com'}]}).links).toEqual([]);
  });

  it('keeps icons of linked networks only, https or a local http host', () => {
    const settings = toSocialSettings({
      links: [
        {network: 'instagram', url: 'https://instagram.com/x'},
        {network: 'youtube', url: 'https://youtube.com/@x'},
        {network: 'tiktok', url: 'https://tiktok.com/@x'},
      ],
      icons: {
        instagram: ICON,
        youtube: 'http://127.0.0.1:9000/b/icon.png',
        tiktok: 'http://files.example.com/icon.png',
        facebook: ICON,
      },
    });
    expect(settings.icons).toEqual({instagram: ICON, youtube: 'http://127.0.0.1:9000/b/icon.png'});
  });

  it('falls back to the defaults for anything else', () => {
    expect(toSocialSettings(null)).toEqual(SOCIAL_DEFAULTS);
    expect(toSocialSettings({links: 'x', shape: 'star', color: 'red', icons: []})).toEqual(SOCIAL_DEFAULTS);
  });
});

describe('socialIconName', () => {
  it('survives the 40 characters upload names keep, for every network, shape and colour', () => {
    for (const network of Object.keys(SOCIAL_NETWORKS) as SocialNetwork[]) {
      for (const shape of SOCIAL_SHAPES) {
        const name = socialIconName(network, shape, '#aabbcc');
        expect(slugify(name)).toBe(name);
      }
    }
  });
});

describe('the social links block', () => {
  const items = [
    {network: 'instagram' as const, url: 'https://instagram.com/x?a=1&b=2', icon: ICON},
    {network: 'email' as const, url: 'mailto:hi@example.com', icon: ICON},
  ];

  it('is written as links to images, escaped, its alignment on the paragraph', () => {
    expect(socialBlockHtml(items, 'medium', 'center')).toBe(
      '<p class="email-social" style="text-align: center;">' +
        `<a href="https://instagram.com/x?a=1&amp;b=2"><img src="${ICON}" alt="Instagram" width="32" height="32"></a>` +
        `<a href="mailto:hi@example.com"><img src="${ICON}" alt="Email" width="32" height="32"></a></p>`,
    );
    expect(socialBlockHtml(items, 'small', null)).toMatch(/^<p class="email-social"><a /);
  });

  it('leaves out items it may not write', () => {
    const html = socialBlockHtml(
      [...items, {network: 'facebook', url: 'https://a.com/{{x}}', icon: ICON}, {...items[0]!, icon: 'data:x'}],
      'large',
      null,
    );
    expect(html.match(/<a /g)).toHaveLength(2);
  });

  it('reads as visual editor content', () => {
    expect(detectCustomHtmlPatterns(`<p>Hi</p>${socialBlockHtml(items, 'medium', 'right')}`)).toBe(false);
    expect(detectCustomHtmlPatterns(socialBlockHtml([], 'medium', null))).toBe(false);
    // As the HTML editor may lay it out
    const html = socialBlockHtml(items, 'medium', null).replace(/<a /g, '\n  <a ').replace('</p>', '\n</p>');
    expect(detectCustomHtmlPatterns(html)).toBe(false);
  });

  it('reads as custom HTML when it holds anything the editor would drop', () => {
    const link = `<a href="https://x.com/a"><img src="${ICON}" alt="X" width="32" height="32"></a>`;
    const foreign = [
      `<p class="email-social">${link}Follow us</p>`,
      `<p class="email-social">${link}<strong>x</strong></p>`,
      `<p class="email-social">${link} x ${link}</p>`,
      `<p class="email-social" title="x">${link}</p>`,
      `<p class="email-social" style="color: red">${link}</p>`,
      `<p class="email-social"><a href="https://x.com/a" title="t"><img src="${ICON}" alt="X" width="32" height="32"></a></p>`,
      `<p class="email-social"><a href="https://x.com/a"><img src="${ICON}" alt="X" width="32" height="32" onerror="x"></a></p>`,
      `<p class="email-social">{% if x %}${link}{% endif %}</p>`,
      `<p class="email-social">${link}`,
    ];
    for (const html of foreign) {
      expect(detectCustomHtmlPatterns(html)).toBe(true);
    }
  });

  it('reads as custom HTML when an item is one the editor would not keep', () => {
    const block = (href: string, src = ICON, alt = 'X') =>
      `<p class="email-social"><a href="${href}"><img src="${src}" alt="${alt}" width="32" height="32"></a></p>`;
    const link = `<a href="https://x.com/a"><img src="${ICON}" alt="X" width="32" height="32"></a>`;
    const foreign = [
      block('https://x.com/a', ICON, 'Foo'),
      block('{{ data.link }}'),
      block('http://x.com/a'),
      block('tel:123'),
      block('https://x.com/a', 'data:image/png;base64,AAA'),
      block('https://x.com/a', 'http://files.example.com/x.png'),
      block('https://x.com/&#97;'),
      `<p class="email-social">${link}${link}</p>`,
      `<p title=">" class="email-social"><a href="https://x.com/a"><img src="${ICON}" alt="X" width="32" height="32"></a></p>`,
      `<p class=email-social><a href="https://x.com/a"><img src="${ICON}" alt="X" width="32" height="32"></a></p>`,
      `<p class="email-social" title='x><a href="https://x.com/a"></a></p>`,
    ];
    for (const html of foreign) {
      expect(detectCustomHtmlPatterns(html)).toBe(true);
    }
    expect(detectCustomHtmlPatterns(block('https://x.com/a?b=1&amp;c=2'))).toBe(false);
  });

  it('checks a long tag in linear time, as contact data can make one', () => {
    const tag = `<p title="${'class='.repeat(40_000)}">x</p>`;
    const started = performance.now();

    expect(detectCustomHtmlPatterns(tag)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('takes the size closest to an icon width', () => {
    expect(socialSizeOf(24)).toBe('small');
    expect(socialSizeOf(35)).toBe('medium');
    expect(socialSizeOf(100)).toBe('large');
  });

  it('is laid out in a row by the prose styles', () => {
    const css = emailProseCss();
    expect(css).toContain('.prose .email-social img {\n  display: inline-block;\n  margin: 0 6px;');
    expect(css).toContain('.prose .email-social a {\n  text-decoration: none;');
  });
});
