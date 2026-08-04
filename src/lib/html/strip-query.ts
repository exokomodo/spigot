/**
 * Query-string removal for URLs that arrive from somewhere else.
 *
 * A link that has been through a share sheet or a newsletter carries the
 * journey with it: `?utm_source=`, YouTube's `?si=`, a click id a mail client
 * appended. The rule here drops the whole query string rather than a list of
 * known-bad parameter names. A blocklist has to anticipate every tracker and
 * every renaming of one; dropping the lot only has to be told once.
 *
 * The fragment survives. `#section-3` is an anchor a reader asked for, part of
 * where the link points rather than a record of how it was passed along.
 *
 * Nothing else changes. `URL` decides whether the input is a URL at all, but the
 * answer is cut out of the original string rather than rebuilt with
 * `toString()`, which would also lowercase the host, drop an explicit `:443` and
 * add a trailing slash to a bare origin. A stored URL that no longer looks like
 * the one that was pasted is a worse surprise than one that kept a parameter.
 */

/**
 * Returns `value` without its query string, unchanged when it has none.
 *
 * A value that does not parse is returned as it came in, so that validation is
 * what refuses it and can say why. Deciding a URL is unusable is not this
 * function's job.
 */
export function stripQueryString(value: string): string {
  if (!URL.canParse(value)) {
    return value;
  }
  // The fragment is everything from the first "#", so a "?" that follows one is
  // part of the fragment and not the start of a query string.
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex === -1) {
    return value;
  }
  const fragment = hashIndex === -1 ? "" : value.slice(hashIndex);
  return beforeHash.slice(0, queryIndex) + fragment;
}
