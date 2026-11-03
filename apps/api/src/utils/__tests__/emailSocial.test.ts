import {markVisualContent, socialBlockHtml, socialSizeOf} from '@plunk/shared';
import signale from 'signale';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {renderBody} from '../emailBody.js';

vi.mock('@plunk/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@plunk/shared')>();
  return {...actual, socialSizeOf: vi.fn(actual.socialSizeOf)};
});

const ICON = 'https://files.example.com/uploads/p/1-0123456789abcdef-plunk-social-x-circle-111827.png';
const items = [
  {network: 'instagram' as const, url: 'https://instagram.com/plunk', icon: ICON},
  {network: 'email' as const, url: 'mailto:hi@example.com', icon: ICON},
];

describe('editor social links (Plunk Lite)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends them as a one-row table, an icon per cell, without the prose styles of images and links', () => {
    const html = renderBody(`<p>Hi</p>${socialBlockHtml(items, 'large', 'center')}`);

    expect(html).not.toContain('email-social');
    expect(html).toContain(
      '<table role="presentation" data-plunk-social align="center" cellpadding="0" cellspacing="0" border="0" style="margin: 1.25em auto 0 auto; border-collapse: collapse;">',
    );
    expect(html.match(/<td style="padding: 0 6px; line-height: 0; font-size: 0;">/g)).toHaveLength(2);
    expect(html).toContain(
      `<a href="https://instagram.com/plunk" style="text-decoration: none;"><img src="${ICON}" alt="Instagram" width="40" height="40" style="display: block; border: 0; width: 40px; height: 40px; margin: 0;"></a>`,
    );
    expect(html).toContain('<a href="mailto:hi@example.com" style="text-decoration: none;">');
  });

  it('aligns and spaces them as the paragraph was', () => {
    expect(renderBody(socialBlockHtml(items, 'medium', null))).toContain('style="margin: 0 0 0 0; border-collapse');
    const right = renderBody(`<p>a</p>${socialBlockHtml(items, 'medium', 'right')}<p>b</p>`);
    expect(right).toContain('align="right"');
    expect(right).toContain('margin: 1.25em 0 1.25em auto;');
  });

  it('sizes icons as the editor offers, never as the body says', () => {
    const html = renderBody(
      `<p class="email-social"><a href="https://x.com/a"><img src="${ICON}" alt="X" width="900" height="1"></a></p>`,
    );

    expect(html).toContain('width="40" height="40"');
    expect(html).not.toContain('900');
  });

  it('drops a link no block may have, as Liquid filled it in, keeping the icon', () => {
    // Judged on the template, as sending does: the rendered link is a contact's data
    const template = socialBlockHtml(items, 'medium', null);
    const html = renderBody(
      markVisualContent(template, template.replace('https://instagram.com/plunk', 'javascript:x')),
    );

    expect(html).toContain('<a style="text-decoration: none;"><img src');
  });

  it('leaves anything else with the class as a paragraph, laid out in a row by its inlined styles', () => {
    const html = renderBody(
      `<p class="email-social"><a href="https://x.com/a"><img src="${ICON}" alt="X" width="32" height="32"></a>Follow us</p>`,
    );

    expect(html).not.toContain('data-plunk-social');
    expect(html).toContain('Follow us');
  });

  it('still sends the email when converting them fails, the icons inline in their paragraph', () => {
    vi.mocked(socialSizeOf).mockImplementationOnce(() => {
      throw new Error('broken social');
    });
    const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);

    const html = renderBody(socialBlockHtml(items, 'medium', null));

    expect(html).toMatch(
      /<img src="[^"]*" alt="Instagram" width="32" height="32" style="[^"]*display: inline-block;[^"]*margin: 0 6px;/,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('convert social links'), expect.any(Error));
  });
});
