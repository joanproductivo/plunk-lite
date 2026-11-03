import {LiquidError, type Template} from 'liquidjs';

import {
  renderEngine,
  SCOPE_ALIAS,
  subjectRenderEngine,
  type TemplateMode,
  textRenderEngine,
  validationEngine,
} from './engine.js';
import {renderLegacyTemplate} from './legacy.js';
import {preprocessTemplate} from './preprocess.js';

export * from './brand.js';
export * from './color.js';
export * from './emailBlocks.js';
export * from './emailBox.js';
export * from './emailButton.js';
export * from './emailDocument.js';
export * from './emailFonts.js';
export * from './emailLink.js';
export * from './emailProseCss.js';
export * from './emailSocial.js';
export * from './emailVideo.js';
export * from './emailVideoSize.js';
export {escapeHtml, neutralizeLiquid} from './html.js';
export {declarations, readPixels, withDeclaration} from './inlineStyle.js';
export * from './optInEmail.js';
export {
  type EmailMarkers,
  joinEmailMarkers,
  markVisualContent,
  preheaderToText,
  readEmailContent,
  splitEmailMarkers,
  textToPreheader,
} from './markers.js';
export * from './unsubscribeFooter.js';

/** A template parsed once and ready to be rendered against many recipients. */
export interface CompiledTemplate {
  /** The original, unpreprocessed template string. */
  readonly source: string;
  /**
   * Whether the source parsed as Liquid. A template that failed to parse still renders
   * — through the legacy placeholder renderer — so sends never break on a bad template.
   */
  readonly valid: boolean;
  render(variables: Record<string, unknown>): string;
}

export interface TemplateValidationResult {
  valid: boolean;
  /** Human-readable description of the first syntax error, if any. */
  error?: string;
  line?: number;
  column?: number;
}

/**
 * Parsed templates are cached so the existing per-email call sites (which pass the same
 * campaign body once per recipient) pay the parse cost once per worker rather than once
 * per send. Bounded on both entry count and template size to keep worker memory flat.
 * One cache per mode: Liquid fixes an output's escaping when it parses it.
 */
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHEABLE_LENGTH = 200_000;

/** Cap on distinct templates we remember having warned about. */
const MAX_REPORTED_SOURCES = 64;

/**
 * `renderFailed` latches the first render-time failure (a runtime limit hit, e.g. an
 * unbounded loop). It lives on the cached parse result rather than in a `compileTemplate`
 * closure because the per-email call sites re-compile the same source for every
 * recipient, so a closure-local flag would reset on each one and every recipient would
 * pay the render budget again.
 */
type ParseResult =
  | {templates: Template[]; renderFailed: boolean; error?: undefined}
  | {templates?: undefined; renderFailed?: undefined; error: Error};

const ENGINES = {html: renderEngine, subject: subjectRenderEngine, text: textRenderEngine};

const parseCaches: Record<TemplateMode, Map<string, ParseResult>> = {
  html: new Map(),
  subject: new Map(),
  text: new Map(),
};

/** Bounded set of template sources already reported, so a bad template logs once. */
const reportedSources = new Set<string>();

function reportOnce(source: string, stage: string, error: unknown): void {
  if (reportedSources.has(source)) {
    return;
  }

  if (reportedSources.size >= MAX_REPORTED_SOURCES) {
    reportedSources.clear();
  }
  reportedSources.add(source);

  const message = error instanceof Error ? error.message : String(error);
  // console rather than signale: @plunk/shared also runs in the browser (editor preview).
  console.warn(`[TEMPLATE] Failed to ${stage} template, falling back to plain variable substitution: ${message}`);
}

function parse(source: string, mode: TemplateMode): ParseResult {
  try {
    return {templates: ENGINES[mode].parse(preprocessTemplate(source)), renderFailed: false};
  } catch (error) {
    reportOnce(source, 'parse', error);
    return {error: error instanceof Error ? error : new Error(String(error))};
  }
}

function parseCached(source: string, mode: TemplateMode): ParseResult {
  const parseCache = parseCaches[mode];
  const cached = parseCache.get(source);
  if (cached) {
    // Re-insert to mark as most recently used.
    parseCache.delete(source);
    parseCache.set(source, cached);
    return cached;
  }

  const result = parse(source, mode);

  if (source.length <= MAX_CACHEABLE_LENGTH) {
    if (parseCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = parseCache.keys().next().value;
      if (oldest !== undefined) {
        parseCache.delete(oldest);
      }
    }
    parseCache.set(source, result);
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten the render scope.
 *
 * Callers pass contact fields both spread at the top level and nested under `data`.
 * Merging keeps both `{{firstName}}` and `{{data.firstName}}` working, with top-level
 * keys winning — the same precedence the old renderer used. `SCOPE_ALIAS` lets
 * preprocessed lookups reach keys whose names contain spaces.
 */
function buildScope(variables: Record<string, unknown>): Record<string, unknown> {
  const nested = variables.data;
  const scope: Record<string, unknown> = isPlainObject(nested) ? {...nested, ...variables} : {...variables};
  scope[SCOPE_ALIAS] = scope;
  return scope;
}

function compile(source: string, mode: TemplateMode): CompiledTemplate {
  const parsed = parseCached(source, mode);

  if (parsed.error) {
    return {
      source,
      valid: false,
      render: variables => renderLegacyTemplate(source, variables, mode),
    };
  }

  return {
    source,
    valid: true,
    render: variables => {
      // A template that already blew a runtime limit will blow it again for every other
      // recipient, so stop asking. Retrying spends the render budget per contact on a
      // campaign that is going out through the legacy renderer regardless.
      if (parsed.renderFailed) {
        return renderLegacyTemplate(source, variables, mode);
      }

      try {
        return String(ENGINES[mode].renderSync(parsed.templates, buildScope(variables)));
      } catch (error) {
        // A render error means a runtime limit was hit (e.g. an unbounded loop).
        parsed.renderFailed = true;
        reportOnce(source, 'render', error);
        return renderLegacyTemplate(source, variables, mode);
      }
    },
  };
}

/**
 * Parse an email body once so it can be rendered for many recipients.
 *
 * Bodies are HTML: every output is escaped (braces included, so a second render finds no
 * tag in the data) unless it ends in `| raw` or comes from `escape` and its kin or `{% capture %}`.
 *
 * Never throws: a template that fails to parse falls back to plain `{{variable}}`
 * substitution, and `valid` reports which path it took. Use `validateTemplate` to
 * surface syntax errors to the author.
 */
export function compileTemplate(source: string): CompiledTemplate {
  return compile(source, 'html');
}

/** `compileTemplate` for a subject: plain text, nothing escaped, and no tag left in the data. */
export function compileSubjectTemplate(source: string): CompiledTemplate {
  return compile(source, 'subject');
}

/**
 * Render an email body.
 *
 * Templates are Liquid, so conditionals, loops and filters are available on top of the
 * `{{variable}}` and `{{variable ?? fallback}}` syntax Plunk has always supported:
 *
 *   renderTemplate('Hello {{name}}!', {name: 'World'})                  -> 'Hello World!'
 *   renderTemplate('Hello {{data.name}}!', {data: {name: 'World'}})     -> 'Hello World!'
 *   renderTemplate('Hello {{name ?? Guest}}!', {})                      -> 'Hello Guest!'
 *   renderTemplate('{% if plan == "pro" %}Pro{% endif %}', {plan: 'pro'}) -> 'Pro'
 *   renderTemplate('Hi {{name}}', {name: '<b>Ann</b>'})                 -> 'Hi &lt;b&gt;Ann&lt;/b&gt;'
 *
 * Never throws. For a template rendered against many recipients, prefer
 * `compileTemplate` to hoist the parse out of the loop.
 */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return compileTemplate(template).render(variables);
}

/** `renderTemplate` for a subject. */
export function renderSubjectTemplate(template: string, variables: Record<string, unknown>): string {
  return compileSubjectTemplate(template).render(variables);
}

/**
 * `renderTemplate` for text that is neither HTML nor rendered again, such as a webhook's
 * URL, headers and body: outputs go in as they are.
 */
export function renderTextTemplate(template: string, variables: Record<string, unknown>): string {
  return compile(template, 'text').render(variables);
}

/**
 * Check a template for syntax errors, for use at authoring time.
 *
 * Stricter than rendering: unknown filters are reported here but skipped at send time,
 * so saving a template can flag a typo without ever blocking a send.
 *
 * Positions come from the preprocessed source. Preprocessing never adds or removes
 * newlines, so `line` always matches the author's template; `column` can be off by the
 * length of a rewrite earlier on the same line.
 */
export function validateTemplate(source: string): TemplateValidationResult {
  try {
    validationEngine.parse(preprocessTemplate(source));
    return {valid: true};
  } catch (error) {
    if (LiquidError.is(error)) {
      const [line, column] = error.token.getPosition();
      return {
        valid: false,
        // Liquid appends ", line:N, col:M" to the message; the position is returned
        // separately so callers can format it themselves.
        error: error.message.replace(/, line:\d+, col:\d+$/, ''),
        line,
        column,
      };
    }

    return {valid: false, error: error instanceof Error ? error.message : String(error)};
  }
}

/** Test seam: drop parsed templates and warning state. */
export function clearTemplateCache(): void {
  for (const parseCache of Object.values(parseCaches)) {
    parseCache.clear();
  }
  reportedSources.clear();
}
