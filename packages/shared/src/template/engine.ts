import {
  CaptureTag,
  type Context,
  CycleTag,
  Drop,
  EchoTag,
  type Emitter,
  Filter,
  filters,
  Liquid,
  toValue,
} from 'liquidjs';

import {withoutCustomHtmlPatterns} from './emailDocument.js';
import {decodeDataEntities, escapeBraces, neutralizeLiquid} from './html.js';

/**
 * Tags that resolve a partial by name through the file system. Template bodies are
 * authored by users, so leaving these enabled turns every template into an arbitrary
 * file read on the worker's disk (`{% render '../../.env' %}`). We both remove the
 * file system (`templates: {}` shadows the `root`/`partials`/`layouts` lookups) and
 * replace the tags, so authors get a clear message instead of a confusing ENOENT.
 */
const BLOCKED_TAGS = ['include', 'render', 'layout'] as const;

/**
 * DoS ceilings. Templates are user input and are rendered once per recipient, so a
 * single pathological template must not be able to stall a worker. The limits are far
 * above anything a real email needs — a 60 KB template renders in tens of
 * microseconds, so a 1 s render budget is roughly four orders of magnitude of slack.
 */
export const TEMPLATE_PARSE_LIMIT = 2_000_000;
export const TEMPLATE_RENDER_LIMIT_MS = 1_000;
export const TEMPLATE_MEMORY_LIMIT = 10_000_000;

/**
 * Key under which the render scope references itself. Liquid has no syntax for
 * looking up a top-level key that contains a space, and CSV imports routinely produce
 * them (a "First Name" header becomes the key `first name`). Templates referencing
 * those keys are rewritten to `__plunk["first name"]` during preprocessing.
 */
export const SCOPE_ALIAS = '__plunk';

/**
 * Preserves the pre-Liquid behaviour of outputting a bare array as an HTML list.
 *
 * Liquid joins arrays without a separator, which would silently mangle templates that
 * relied on `{{ items }}` rendering `<li>` elements. The text engine (webhooks) uses it
 * as Liquid's `outputEscape` hook, which appends itself to every output's filter chain —
 * so `{{ items | raw }}` opts out and `{% for %}` is unaffected.
 */
function renderArrayAsListItems(value: unknown): string {
  if (!Array.isArray(value)) {
    // Not necessarily a string: Liquid stringifies whatever we hand back, and
    // deferring to it keeps Drops, dates and numbers formatted exactly as usual.
    return value as string;
  }

  return value.map(item => `<li>${item ?? ''}</li>`).join('\n');
}

/**
 * Markup a template made itself, which a body prints as it is: what `escape` and its kin
 * return, and what `{% capture %}` holds (its outputs were escaped as they were written).
 */
class SafeHtml extends Drop {
  constructor(readonly html: string) {
    super();
  }

  override valueOf(): string {
    return this.html;
  }

  toString(): string {
    return this.html;
  }
}

/** What Liquid passes a filter as `this`: the render context, which counts memory. */
interface FilterScope {
  context: Context;
}

// Liquid's own HTML filters, typed as what they are: functions of their scope and value
type HtmlFilter = (this: FilterScope, value: unknown) => string;
const liquidEscape = filters.escape as unknown as HtmlFilter;
const liquidEscapeOnce = filters.escape_once as unknown as HtmlFilter;

// Liquid's own escape (`& < > " '`, counted against the memory limit), with braces as
// entities on top so a second render of the body finds no tag in a contact's data, and
// nothing in it that would make the email read as custom HTML
function escapeText(scope: FilterScope, value: unknown): string {
  return withoutCustomHtmlPatterns(escapeBraces(liquidEscape.call(scope, value)));
}

function escapeValue(scope: FilterScope, value: unknown): string {
  return value instanceof SafeHtml ? value.html : escapeText(scope, value);
}

/**
 * Bodies are HTML, and contact and event data are not: every output is escaped unless
 * the template opts out with `| raw` or the value is already `SafeHtml`. A bare array
 * is still a list, with each item escaped.
 */
function escapeOutput(this: FilterScope, value: unknown): string {
  if (Array.isArray(value)) {
    // A nested list reads as before, its items joined with commas
    return value.map(item => `<li>${escapeValue(this, Array.isArray(item) ? String(item) : item)}</li>`).join('\n');
  }
  return escapeValue(this, value);
}

// Liquid's stringify, which is not exported: what an output turns `value` into
function toText(value: unknown): string {
  const plain = toValue(value);
  if (typeof plain === 'string') return plain;
  if (plain === null || plain === undefined) return '';
  if (Array.isArray(plain)) return plain.map(toText).join('');
  return String(plain);
}

/**
 * Subjects are plain text, so nothing is escaped, but sending renders them twice: no
 * `{{` or `{%` in the data survives as a tag.
 */
function subjectOutput(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map(item => `<li>${neutralizeLiquid(Array.isArray(item) ? String(item) : toText(item))}</li>`)
      .join('\n');
  }
  return neutralizeLiquid(toText(value));
}

/** What an engine does with an output's value before writing it. */
type OutputFilter = (this: FilterScope, value: unknown) => string;

/**
 * `output` as an entry in a filter chain, for the tags that write without going through an
 * output. Liquid does not export `FilterToken`, so the token is built from the two fields
 * `Filter` reads.
 */
function outputFilter(liquid: Liquid, output: OutputFilter): Filter {
  const token = {name: 'escape', args: []} as unknown as ConstructorParameters<typeof Filter>[0];
  return new Filter(token, output, liquid);
}

/**
 * `{% echo %}` and `{% cycle %}` write their values without an output, so they get what
 * outputs get: escaped in a body, with no tag left in a subject.
 */
function writingTags(output: OutputFilter): {echo: typeof EchoTag; cycle: typeof CycleTag} {
  class OutputEchoTag extends EchoTag {
    constructor(...args: ConstructorParameters<typeof EchoTag>) {
      super(...args);
      // `value` is private in Liquid's typings, though tags written outside it read it too
      const chain = (this as unknown as {value?: {filters: Filter[]}}).value?.filters;
      if (chain && !chain[chain.length - 1]?.raw) {
        chain.push(outputFilter(this.liquid, output));
      }
    }
  }

  // `{% cycle %}` returns its value, which Liquid writes as it is
  class OutputCycleTag extends CycleTag {
    override *render(ctx: Context, emitter: Emitter): Generator<unknown, unknown, unknown> {
      const value = yield* super.render(ctx, emitter);
      return output.call({context: ctx}, value);
    }
  }

  return {echo: OutputEchoTag, cycle: OutputCycleTag};
}

// Its outputs were escaped as they rendered, so what it captured prints as it is
class SafeCaptureTag extends CaptureTag {
  override *render(ctx: Context): Generator<unknown, void, unknown> {
    const html = (yield this.liquid.renderer.renderTemplates(this.templates, ctx)) as string;
    ctx.bottom()[this.variable] = new SafeHtml(html);
  }
}

/** What a template's outputs are for, which decides what is done with their values. */
export type TemplateMode = 'html' | 'subject' | 'text';

// The filters and tags that escape in HTML, or keep what is already safe from escaping twice
function registerHtmlEscaping(engine: Liquid): void {
  for (const name of ['escape', 'xml_escape'] as const) {
    engine.registerFilter(name, {
      raw: true,
      handler(this: FilterScope, value: unknown) {
        return new SafeHtml(escapeText(this, value));
      },
    });
  }
  // The entities this engine adds to escaped data count as escaped too
  engine.registerFilter('escape_once', {
    raw: true,
    handler(this: FilterScope, value: unknown) {
      const text = decodeDataEntities(toText(value));
      return new SafeHtml(withoutCustomHtmlPatterns(escapeBraces(liquidEscapeOnce.call(this, text))));
    },
  });
  // `| escape | newline_to_br` is how text with line breaks is written: escape once, then break
  engine.registerFilter('newline_to_br', {
    raw: true,
    handler(this: FilterScope, value: unknown) {
      return new SafeHtml(escapeValue(this, value).replace(/\r?\n/gm, '<br />\n'));
    },
  });
  // The length of what a capture holds, not of the object holding it
  engine.registerFilter('size', (value: unknown) => {
    const plain = toValue(value) as {length?: number} | null | undefined;
    return (plain && plain.length) || 0;
  });
  const tags = writingTags(escapeOutput);
  engine.registerTag('echo', tags.echo);
  engine.registerTag('capture', SafeCaptureTag);
  engine.registerTag('cycle', tags.cycle);
}

// The tags that write without an output leave no tag either, and `| raw`, which means
// nothing in plain text, still breaks the ones in the data
function registerSubjectNeutralizing(engine: Liquid): void {
  const tags = writingTags(subjectOutput);
  engine.registerTag('echo', tags.echo);
  engine.registerTag('cycle', tags.cycle);
  engine.registerFilter('raw', {raw: true, handler: (value: unknown) => neutralizeLiquid(toText(value))});
}

const OUTPUT_ESCAPE = {html: escapeOutput, subject: subjectOutput, text: renderArrayAsListItems};

function createEngine({strictFilters, mode}: {strictFilters: boolean; mode: TemplateMode}): Liquid {
  const engine = new Liquid({
    // No file system access whatsoever — see BLOCKED_TAGS.
    templates: {},
    relativeReference: false,
    // JavaScript truthiness. Contact data arrives from CSV imports and API payloads
    // where "key present but blank" is the norm, and Liquid's Shopify-compatible
    // truthiness would make `{% if firstName %}` true for an empty string.
    jsTruthy: true,
    // Contact data is unsanitised user input; never walk its prototype chain.
    ownPropertyOnly: true,
    // An unknown variable renders as an empty string, matching the previous
    // regex-based renderer. Templates are written against per-contact custom fields
    // that legitimately differ from contact to contact, so this can't be strict.
    strictVariables: false,
    strictFilters,
    parseLimit: TEMPLATE_PARSE_LIMIT,
    renderLimit: TEMPLATE_RENDER_LIMIT_MS,
    memoryLimit: TEMPLATE_MEMORY_LIMIT,
    outputEscape: OUTPUT_ESCAPE[mode],
  });

  for (const name of BLOCKED_TAGS) {
    engine.registerTag(name, {
      parse() {
        throw new Error(`The {% ${name} %} tag is not available in Plunk templates`);
      },
      render() {
        return '';
      },
    });
  }

  if (mode === 'html') {
    registerHtmlEscaping(engine);
  } else if (mode === 'subject') {
    registerSubjectNeutralizing(engine);
  }

  return engine;
}

/** Engine for email bodies. Lenient: unknown filters and variables are skipped. */
export const renderEngine = createEngine({strictFilters: false, mode: 'html'});

/** Engine for subjects: plain text, with no template tag left for the second render. */
export const subjectRenderEngine = createEngine({strictFilters: false, mode: 'subject'});

/** Engine for webhook URLs, headers and bodies: rendered once, and not HTML. */
export const textRenderEngine = createEngine({strictFilters: false, mode: 'text'});

/**
 * Engine used by `validateTemplate` at authoring time. Identical to the body engine except
 * that unknown filters raise, so a typo like `{{ name | upcse }}` is reported while the
 * author is still editing rather than silently dropping the value from every email.
 */
export const validationEngine = createEngine({strictFilters: true, mode: 'html'});
