/**
 * Whether a body outputs one of these template variables, in any spacing Liquid accepts
 * ({{unsubscribeUrl}}, {{ manageUrl }}, {{- unsubscribeUrl -}}), optionally with filters that
 * leave the URL intact. Names are plain identifiers.
 */
export function usesVariable(body: string, ...names: string[]): boolean {
  if (!body || names.length === 0) return false;
  return new RegExp(`\\{\\{-?\\s*(?:${names.join('|')})\\s*(?:\\|\\s*(?:strip|escape)\\s*)*-?\\}\\}`).test(body);
}

/**
 * Detects whether an email body contains an unsubscribe signal.
 *
 * Used to warn authors of HEADLESS emails that no unsubscribe mechanism
 * was found — Plunk cannot verify the link works, but can check for common patterns.
 *
 * Returns true if any of the following are present:
 * - Plunk template variables: {{unsubscribeUrl}} or {{manageUrl}}
 * - An <a> tag whose href contains unsubscribe-related keywords
 * - An <a> tag whose visible text contains unsubscribe-related keywords
 */
export function detectUnsubscribeSignal(body: string): boolean {
  if (!body) return false;

  // Plunk's own managed unsubscribe variables
  if (usesVariable(body, 'unsubscribeUrl', 'manageUrl')) return true;

  // Plunk Lite: {{optOutUrl}} is no unsubscribe link here: it is empty outside a transactional
  // template or campaign with an opt-out topic, and its name would pass for one below
  const markup = body.replace(/\{\{-?\s*optOutUrl\b[^}]*\}\}/g, '');

  // href containing unsubscribe keywords
  if (/href=["'][^"']*(?:unsubscribe|opt[_-]?out|remove)[^"']*["']/i.test(markup)) return true;

  // Anchor text containing unsubscribe keywords
  if (/<a\b[^>]*>(?:[^<]*(?:unsubscribe|opt[_-]?\s*out|manage\s+preferences|email\s+preferences|remove\s+me)[^<]*)<\/a>/i.test(markup))
    return true;

  return false;
}
