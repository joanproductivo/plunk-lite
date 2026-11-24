import {describe, expect, it} from 'vitest';

import {detectUnsubscribeSignal, usesVariable} from '../unsubscribe.js';

describe('detectUnsubscribeSignal', () => {
  it.each([
    '<a href="{{unsubscribeUrl}}">Click here</a>',
    '<a href="{{manageUrl}}">Your settings</a>',
    '<a href="{{ manageUrl }}">Your settings</a>',
    '<a href="{{- manageUrl -}}">Your settings</a>',
    '<a href="{{ manageUrl | strip }}">Your settings</a>',
    '<p>Stop these emails: {{ unsubscribeUrl }}</p>',
  ])('finds the managed placeholder in %s', body => {
    expect(detectUnsubscribeSignal(body)).toBe(true);
  });

  it('finds an unsubscribe link written by the sender', () => {
    expect(detectUnsubscribeSignal('<a href="https://example.com/opt-out">Leave</a>')).toBe(true);
    expect(detectUnsubscribeSignal('<a href="https://example.com/x">Unsubscribe</a>')).toBe(true);
  });

  it.each([
    '',
    '<p>Hello {{ firstName }}</p>',
    '<p>{{ unsubscribeUrlText }}</p>',
    '<a href="{{ url }}">Read more</a>',
    '<p>{{ unsubscribeUrl | truncate: 5 }}</p>',
    '<p>{{ unsubscribeUrl | size }}</p>',
    '<p>{{ unsubscribeUrl | replace: "unsubscribe", "home" }}</p>',
    '<p>{{ unsubscribeUrl.foo }}</p>',
    '<p>{{ unsubscribeUrl and x }}</p>',
  ])(
    'reports no signal for %s',
    body => {
      expect(detectUnsubscribeSignal(body)).toBe(false);
    },
  );
});

// Plunk Lite: the check behind detectUnsubscribeSignal, also used for {{optOutUrl}}
describe('usesVariable', () => {
  it.each(['{{optOutUrl}}', '{{ optOutUrl }}', '{{- optOutUrl -}}', '{{optOutUrl | strip}}'])('finds %s', body => {
    expect(usesVariable(`<a href="${body}">x</a>`, 'optOutUrl')).toBe(true);
  });

  it('does not find another variable, a longer name, or nothing', () => {
    expect(usesVariable('{{optOutUrlX}}', 'optOutUrl')).toBe(false);
    expect(usesVariable('{{unsubscribeUrl}}', 'optOutUrl')).toBe(false);
    expect(usesVariable('', 'optOutUrl')).toBe(false);
    expect(usesVariable('{{optOutUrl}}')).toBe(false);
  });

  it('does not let {{optOutUrl}} pass for an unsubscribe link, as it is empty in a headless template', () => {
    expect(detectUnsubscribeSignal('<p>{{optOutUrl}}</p>')).toBe(false);
    expect(detectUnsubscribeSignal('<a href="{{optOutUrl}}">Stop</a>')).toBe(false);
    expect(detectUnsubscribeSignal('<a href="{{ optOutUrl }}">Stop</a> <a href="{{unsubscribeUrl}}">x</a>')).toBe(true);
  });
});
