import {describe, expect, it} from 'vitest';

import {isSafeLinkHref, isValidLinkHref} from '../template/index.js';

describe('isSafeLinkHref', () => {
  it.each([
    'https://example.com',
    'http://example.com',
    'mailto:hi@example.com',
    'tel:+34600000000',
    '#top',
    '{{unsubscribeUrl}}',
    '{% if pro %}https://a.com{% else %}https://b.com{% endif %}',
  ])('allows %s', href => {
    expect(isSafeLinkHref(href)).toBe(true);
  });

  it.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'example.com', '', null])(
    'rejects %s',
    href => {
      expect(isSafeLinkHref(href)).toBe(false);
    },
  );
});

describe('isValidLinkHref', () => {
  it.each(['https://example.com', ' https://example.com ', '{{ unsubscribeUrl }}', 'https://a.com/{{ id }}'])(
    'accepts %s',
    href => {
      expect(isValidLinkHref(href)).toBe(true);
    },
  );

  it.each(['https://example.com/a b', 'www.example.com', 'javascript:alert(1)', ''])('rejects %s', href => {
    expect(isValidLinkHref(href)).toBe(false);
  });
});
