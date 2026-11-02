/** Escapes text for use in HTML content or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Writes braces as entities, which HTML shows the same: a value placed in a body that Liquid
 * renders again (sending does) can then not be read as a template tag there.
 */
export function escapeBraces(value: string): string {
  return value.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}

/**
 * Breaks every brace in plain text with a zero-width space, for text that is not HTML (a
 * subject) and that Liquid may render again: it reads the same, but holds no template tag,
 * not even with a `{` at its end and another value starting with `{` or `%` after it.
 */
export function neutralizeLiquid(value: string): string {
  return value.replace(/\{/g, '{\u200b');
}

/**
 * The entities a body's escaped data carries besides HTML's own (braces, and what keeps it
 * from reading as custom HTML), back to their characters.
 */
export function decodeDataEntities(value: string): string {
  return value.replace(/&#(123|125|45|61|64);/g, (_entity, code: string) => String.fromCharCode(Number(code)));
}
