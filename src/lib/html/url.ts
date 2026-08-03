/**
 * Scheme checking for URLs that reach an `href`.
 *
 * Escaping does not help here. `escapeHtml("javascript:alert(1)")` returns the
 * string unchanged — there is nothing in it to escape — so an entry URL taken
 * from a request lands in the attribute intact and is one click from executing.
 * `data:text/html,...` and `vbscript:` are the same class of problem.
 *
 * The check is an allowlist rather than a blocklist of known-bad schemes. A
 * blocklist has to anticipate every dangerous scheme and every spelling of it;
 * an allowlist only has to name the two that are wanted.
 *
 * Parsing is delegated to `URL` rather than matched with a regular expression,
 * because the tricky part is normalization, not shape. `URL` lowercases the
 * scheme and strips leading whitespace and embedded tabs and newlines exactly
 * as a browser does, so `" javascript:"`, `"JavaScript:"` and
 * `"java\tscript:"` all resolve to the same protocol a browser would act on.
 */

const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * True when `value` is an absolute URL a browser would fetch over HTTP(S).
 *
 * Relative URLs are rejected along with everything else: `URL` cannot resolve
 * one without a base, and an entry that does not say where it lives is not
 * something to link to anyway.
 */
export function isSafeHttpUrl(value: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    // Not a URL at all. Unparseable is untrustworthy.
    return false;
  }
}

/** The safe protocols, for error messages that tell the caller what is accepted. */
export const SAFE_PROTOCOL_LIST = "http:// or https://";
