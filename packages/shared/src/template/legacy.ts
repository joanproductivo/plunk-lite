import {withoutCustomHtmlPatterns} from './emailDocument.js';
import type {TemplateMode} from './engine.js';
import {escapeBraces, escapeHtml, neutralizeLiquid} from './html.js';

// The fallback must not throw itself: data such as `{"toString": "x"}` has no text form
function asText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// As the Liquid engine of each mode writes a value; `'` too, as Liquid's escape does, since
// a value may sit in a single-quoted attribute
const WRITERS: Record<TemplateMode, (value: unknown) => string> = {
  html: value => withoutCustomHtmlPatterns(escapeBraces(escapeHtml(asText(value)).replace(/'/g, '&#39;'))),
  subject: value => neutralizeLiquid(asText(value)),
  text: value => asText(value),
};

/**
 * The pre-Liquid renderer, kept as a safety net.
 *
 * Templates are authored by users and stored indefinitely, so a template that Liquid
 * refuses to parse must not take a campaign down with it. When parsing fails,
 * `renderTemplate` falls back to this function: plain `{{variable}}` and
 * `{{variable ?? default}}` placeholders still resolve, and anything Liquid-specific is
 * left as literal text. `validateTemplate` is what surfaces the actual error to the
 * author.
 *
 * Supports `{{variable}}`, `{{variable ?? defaultValue}}` and nested access
 * (`{{data.firstName}}`). Values are written as the Liquid engine of `mode` writes them:
 * escaped in a body, with no template tag left in a subject, as they are in a webhook.
 */
export function renderLegacyTemplate(template: string, variables: Record<string, unknown>, mode: TemplateMode): string {
  const write = WRITERS[mode];

  return template.replace(/\{\{(.*?)\}\}/g, (_match, key) => {
    const [mainKey, defaultValue] = key.split('??').map((s: string) => s.trim());

    // Handle nested property access (e.g., data.firstName)
    const getValue = (obj: Record<string, unknown>, path: string): unknown => {
      return path.split('.').reduce((current: Record<string, unknown> | unknown, segment) => {
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          return (current as Record<string, unknown>)[segment];
        }
        return undefined;
      }, obj);
    };

    // Try multiple lookup strategies
    const value =
      getValue(variables, mainKey) || // Try as nested path (e.g., data.firstName)
      variables[mainKey] || // Try as top-level property
      (variables.data as Record<string, unknown>)?.[mainKey]; // Try in data object

    // Handle array values (for lists)
    if (Array.isArray(value)) {
      return value.map((e: unknown) => `<li>${write(asText(e))}</li>`).join('\n');
    }

    return write(value ?? defaultValue ?? '');
  });
}
