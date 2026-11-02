import * as liquid from 'liquidjs';
import {beforeEach, describe, expect, it} from 'vitest';

import {
  clearTemplateCache,
  compileSubjectTemplate,
  compileTemplate,
  preheaderToText,
  renderSubjectTemplate,
  renderTemplate,
  renderTextTemplate,
  validateTemplate,
} from '../template/index.js';

/**
 * Plunk Lite: email bodies are HTML, and contact and event data are not, so a body's outputs
 * are escaped. Braces too, because sending renders a body twice and a value must not turn into
 * a tag the second time. Subjects are plain text and webhooks are neither, so each has its own
 * engine.
 */
describe('escaped Liquid output', () => {
  beforeEach(() => {
    clearTemplateCache();
  });

  // A contact field written to break out of an attribute or into the markup
  const attack = 'https://ok.test/" onclick="alert(1)" style="position:fixed';
  const markup = '<a href="https://phish.test">Verify</a>';

  describe('bodies', () => {
    it('writes what would make an editor email read as custom HTML as entities', () => {
      const vars = {v: 'Ann @media x id=1 data-a role=b class=c'};
      expect(renderTemplate('<p>{{ v }}</p>', vars)).toBe(
        '<p>Ann &#64;media x id&#61;1 data&#45;a role&#61;b class&#61;c</p>',
      );
      expect(renderTemplate('<a href="{{ url }}">x</a>', {url: 'https://a.test/?id=1&data-x=2'})).toBe(
        '<a href="https://a.test/?id=1&amp;data-x=2">x</a>',
      );
      expect(renderTemplate('{{ v | escape | escape_once }}', vars)).toBe(renderTemplate('{{ v }}', vars));
      expect(preheaderToText(renderTemplate('{{ v }}', vars))).toBe(vars.v);
    });

    it('never throws on data with no text form, in Liquid or its fallback', () => {
      const vars = {data: {a: {toString: '<b>'}}};
      expect(() => renderTemplate('{{ data.a }}', vars)).not.toThrow();
      expect(() => renderTemplate('{% if %}{{ data.a }}', vars)).not.toThrow();
    });

    it('keeps a value inside its attribute', () => {
      expect(renderTemplate('<a href="{{ data.url }}">Go</a>', {data: {url: attack}})).toBe(
        '<a href="https://ok.test/&#34; onclick=&#34;alert(1)&#34; style=&#34;position:fixed">Go</a>',
      );
    });

    it('keeps a value inside a single-quoted attribute', () => {
      expect(renderTemplate("<a href='{{ url }}'>Go</a>", {url: "x' onclick='y"})).toBe(
        "<a href='x&#39; onclick=&#39;y'>Go</a>",
      );
    });

    it('writes markup in a value as text', () => {
      expect(renderTemplate('<p>Hi {{ name }}</p>', {name: markup})).toBe(
        '<p>Hi &lt;a href=&#34;https://phish.test&#34;&gt;Verify&lt;/a&gt;</p>',
      );
    });

    it('writes braces as entities, so a second render finds no tag', () => {
      const once = renderTemplate('<p>{{ name }}</p>', {name: '{{ unsubscribeUrl }}{% if 1 %}X{% endif %}'});
      expect(once).toBe('<p>&#123;&#123; unsubscribeUrl &#125;&#125;&#123;% if 1 %&#125;X&#123;% endif %&#125;</p>');
      expect(renderTemplate(once, {unsubscribeUrl: 'https://u.test'})).toBe(once);
    });

    it('escapes each item of a list', () => {
      expect(renderTemplate('{{ items }}', {items: ['<b>a</b>', 'b & c']})).toBe(
        '<li>&lt;b&gt;a&lt;/b&gt;</li>\n<li>b &amp; c</li>',
      );
    });

    it('leaves dates, numbers and plain text as they were', () => {
      expect(
        renderTemplate('{{ "2024-01-15" | date: "%Y" }} {{ n | plus: 1 }} {{ name | upcase }}', {n: 41, name: 'ada'}),
      ).toBe('2024 42 ADA');
    });

    it('prints a value as it is with | raw, with or without a fallback', () => {
      expect(renderTemplate('{{ html | raw }}', {html: '<b>x</b>'})).toBe('<b>x</b>');
      expect(renderTemplate('{{ html | raw ?? none }}', {html: '<b>x</b>'})).toBe('<b>x</b>');
      expect(renderTemplate('{{ html | raw ?? none }}', {})).toBe('none');
    });

    it('escapes a fallback the author wrote', () => {
      expect(renderTemplate('{{ name ?? Tom & Jerry }}', {})).toBe('Tom &amp; Jerry');
    });

    it('escapes once when a filter that escapes has a fallback', () => {
      expect(renderTemplate('{{ name | escape ?? Friend }}', {name: '<b>'})).toBe('&lt;b&gt;');
      expect(renderTemplate('{{ name | escape ?? Friend }}', {})).toBe('Friend');
      expect(renderTemplate('{{ text | newline_to_br ?? none }}', {text: 'a\nb'})).toBe('a<br />\nb');
    });

    it('writes a nested list item as before, joined with commas', () => {
      expect(renderTemplate('{{ items }}', {items: [['a', '<b>'], 'c']})).toBe('<li>a,&lt;b&gt;</li>\n<li>c</li>');
    });

    it('takes braces it escaped as escaped in escape_once', () => {
      expect(renderTemplate('{{ v | escape | escape_once }}', {v: '{x} &'})).toBe('&#123;x&#125; &amp;');
    });

    it('escapes only once with escape, escape_once and xml_escape', () => {
      const vars = {name: 'A & <b>{x}</b>'};
      expect(renderTemplate('{{ name | escape }}', vars)).toBe('A &amp; &lt;b&gt;&#123;x&#125;&lt;/b&gt;');
      expect(renderTemplate('{{ name | xml_escape }}', vars)).toBe('A &amp; &lt;b&gt;&#123;x&#125;&lt;/b&gt;');
      expect(renderTemplate('{{ v | escape_once }}', {v: 'A &amp; <b>'})).toBe('A &amp; &lt;b&gt;');
    });

    it('breaks lines once the text is escaped, however newline_to_br is reached', () => {
      const vars = {text: 'a <b>\nb'};
      expect(renderTemplate('{{ text | newline_to_br }}', vars)).toBe('a &lt;b&gt;<br />\nb');
      expect(renderTemplate('{{ text | escape | newline_to_br }}', vars)).toBe('a &lt;b&gt;<br />\nb');
    });

    it('escapes echo, liquid echo and cycle, which write without an output', () => {
      const vars = {name: '<b>'};
      expect(renderTemplate('{% echo name %}', vars)).toBe('&lt;b&gt;');
      expect(renderTemplate('{% liquid\necho name\n%}', vars)).toBe('&lt;b&gt;');
      expect(renderTemplate('{% echo name | raw %}', vars)).toBe('<b>');
      expect(renderTemplate('{% cycle name, "x" %}{% cycle name, "x" %}', vars)).toBe('&lt;b&gt;x');
    });

    it('prints what a capture holds once, its outputs already escaped', () => {
      const vars = {name: '<b>'};
      expect(renderTemplate('{% capture g %}<i>{{ name }}</i>{% endcapture %}{{ g }}', vars)).toBe('<i>&lt;b&gt;</i>');
      expect(renderTemplate('{% capture g %}{% echo name %}{% cycle name %}{% endcapture %}{{ g }}', vars)).toBe(
        '&lt;b&gt;&lt;b&gt;',
      );
      expect(renderTemplate('{% capture g %}<i>{% endcapture %}{% assign h = g %}{{ h }}', vars)).toBe('<i>');
    });

    it('compares and measures what a capture holds as text', () => {
      expect(renderTemplate('{% capture g %}abc{% endcapture %}{% if g == "abc" %}same{% endif %}', {})).toBe('same');
      expect(renderTemplate('{% capture g %}abc{% endcapture %}{{ g | size }}', {})).toBe('3');
      expect(renderTemplate('{% capture g %}{% endcapture %}{% if g %}full{% else %}empty{% endif %}', {})).toBe(
        'empty',
      );
    });

    it('escapes a capture twice once a text filter turns it back into text (accepted)', () => {
      // A text filter's result is text again: marking it safe would let `| append: name` through
      expect(renderTemplate('{% capture g %}<i>{% endcapture %}{{ g | upcase }}', {})).toBe('&lt;I&gt;');
    });

    it('escapes json and url_encode output', () => {
      expect(renderTemplate('{{ v | json }}', {v: {a: '<b>'}})).toBe('&#123;&#34;a&#34;:&#34;&lt;b&gt;&#34;&#125;');
      expect(renderTemplate('{{ v | url_encode }}', {v: 'a b&c'})).toBe('a+b%26c');
    });

    it('escapes assign and default literals too', () => {
      expect(renderTemplate('{% assign t = "<b>" %}{{ t }}', {})).toBe('&lt;b&gt;');
      expect(renderTemplate('{{ x | default: "<b>" }}', {})).toBe('&lt;b&gt;');
    });

    it('escapes through the legacy fallback when Liquid cannot parse the body', () => {
      const compiled = compileTemplate('{% if %}<p>{{ name }}</p>');
      expect(compiled.valid).toBe(false);
      expect(compiled.render({name: "<b>'{{x}}'</b>"})).toBe(
        '{% if %}<p>&lt;b&gt;&#39;&#123;&#123;x&#125;&#125;&#39;&lt;/b&gt;</p>',
      );
    });
  });

  describe('subjects', () => {
    it('leaves no tag where two values meet', () => {
      const vars = {a: '{', b: '{ unsubscribeUrl }}', unsubscribeUrl: 'https://u.test'};
      const once = renderSubjectTemplate('{{ a }}{{ b }}', vars);
      expect(renderSubjectTemplate(once, vars)).toBe(once);
      expect(renderSubjectTemplate(renderSubjectTemplate('{% if %}{{a}}{{b}}', vars), vars)).not.toContain('https');
    });

    it('leaves no tag in what echo, cycle and | raw write either', () => {
      const vars = {name: 'Ann {{ unsubscribeUrl }}', unsubscribeUrl: 'https://u.test'};
      for (const template of [
        '{% echo name %}',
        '{% liquid\necho name\n%}',
        '{% cycle name, "b" %}',
        '{{ name | raw }}',
      ]) {
        const once = renderSubjectTemplate(template, vars);
        expect(once).toBe('Ann {\u200b{\u200b unsubscribeUrl }}');
        expect(renderSubjectTemplate(once, vars)).toBe(once);
      }
    });

    it('writes text as it is', () => {
      expect(renderSubjectTemplate('Hi {{ name }}', {name: "O'Brien & <Co>"})).toBe("Hi O'Brien & <Co>");
    });

    it('leaves no tag for a second render', () => {
      const once = renderSubjectTemplate('Hi {{ name }}', {name: '{{ unsubscribeUrl }} {%- if 1 -%}'});
      expect(once).toBe('Hi {\u200b{\u200b unsubscribeUrl }} {\u200b%- if 1 -%}');
      expect(renderSubjectTemplate(once, {unsubscribeUrl: 'https://u.test'})).toBe(once);
    });

    it('keeps lists, dates and the legacy fallback', () => {
      expect(renderSubjectTemplate('{{ items }}', {items: ['a', '{{b}}']})).toBe(
        '<li>a</li>\n<li>{\u200b{\u200bb}}</li>',
      );
      expect(renderSubjectTemplate('{{ "2024-01-15" | date: "%Y" }}', {})).toBe('2024');
      const compiled = compileSubjectTemplate('{% if %}{{ name }}');
      expect(compiled.valid).toBe(false);
      expect(compiled.render({name: 'A & {{x}}'})).toBe('{% if %}A & {\u200b{\u200bx}}');
    });
  });

  describe('webhooks', () => {
    it('writes values as they are', () => {
      expect(renderTextTemplate('{"name": "{{ name }}", "q": "{{ q }}"}', {name: '<b>&', q: '{{x}}'})).toBe(
        '{"name": "<b>&", "q": "{{x}}"}',
      );
      expect(renderTextTemplate('{{ items }}', {items: ['<a>']})).toBe('<li><a></li>');
    });

    it('writes values as they are through the legacy fallback', () => {
      expect(renderTextTemplate('{% if %}{{ name }}', {name: '<b>'})).toBe('{% if %}<b>');
    });
  });

  it('caches each mode apart', () => {
    const vars = {name: '<b>'};
    expect(renderTemplate('{{ name }}', vars)).toBe('&lt;b&gt;');
    expect(renderSubjectTemplate('{{ name }}', vars)).toBe('<b>');
    expect(renderTextTemplate('{{ name }}', vars)).toBe('<b>');
    expect(renderTemplate('{{ name }}', vars)).toBe('&lt;b&gt;');
  });

  it('validates the filters and tags bodies escape with', () => {
    expect(
      validateTemplate('{{ a | escape | newline_to_br }}{% capture g %}{% echo a %}{% endcapture %}{% cycle "x" %}')
        .valid,
    ).toBe(true);
    expect(validateTemplate('{{ a | upcse }}').valid).toBe(false);
  });

  it('shows the braces of a rendered preheader as braces', () => {
    expect(preheaderToText('&#123;&#123; x &#125;&#125; &amp; y')).toBe('{{ x }} & y');
    // An entity the author typed is stored escaped, and shows as typed
    expect(preheaderToText('a &amp;#123; b')).toBe('a &#123; b');
  });

  // The engine extends parts of Liquid that are not its public API; an upgrade that changes
  // them must fail here, not in a sent email
  it('finds the parts of liquidjs the body engine relies on', () => {
    expect(liquid.CaptureTag.prototype.render).toBeTypeOf('function');
    expect(liquid.CycleTag.prototype.render).toBeTypeOf('function');
    expect(liquid.EchoTag.prototype.render).toBeTypeOf('function');
    expect(liquid.filters.escape).toBeTypeOf('function');
    expect(liquid.filters.escape_once).toBeTypeOf('function');
    const engine = new liquid.Liquid();
    const [output] = engine.parse('{{ a | upcase }}') as unknown as [{value: {filters: {raw: boolean}[]}}];
    expect(output.value.filters).toHaveLength(1);
    expect(renderTemplate('{% echo a | upcase %}', {a: '<b>'})).toBe('&lt;B&gt;');
  });
});
