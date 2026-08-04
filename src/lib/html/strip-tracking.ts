/**
 * Tracking-parameter removal for URLs that arrive from somewhere else.
 *
 * A link that has been through a share sheet or a newsletter carries the
 * journey with it: `?utm_source=`, YouTube's `?si=`. Only those named
 * parameters go. Dropping the whole query instead would take with it the parts
 * that are the link — a `t=120` timestamp, the `v=` that says which video, a
 * page number, a search term — and a URL that lands somewhere other than where
 * the pasted one did is a worse outcome than one that kept a tracker.
 *
 * The fragment survives too. `#section-3` is an anchor a reader asked for, part
 * of where the link points rather than a record of how it was passed along.
 *
 * Nothing else changes. `URL` decides whether the input is a URL at all, but the
 * answer is cut out of the original string rather than rebuilt with
 * `toString()`, which would also lowercase the host, drop an explicit `:443` and
 * add a trailing slash to a bare origin. The surviving query is spliced back
 * together from the raw text for the same reason, rather than run through
 * `URLSearchParams.toString()`: that re-encodes, so a space comes back as `+`
 * and reserved characters are escaped differently than they arrived. A stored
 * URL that no longer looks like the one that was pasted is a worse surprise than
 * one that kept a parameter.
 */

/** Campaign tags all share this prefix: `utm_source`, `utm_medium`, `utm_campaign` and the rest. */
export const TRACKING_PARAMETER_PREFIX = "utm_";

/**
 * Trackers with no shared prefix, matched whole and case-insensitively.
 *
 * Every name here is minted by an ad, email or share platform and means nothing
 * to the page being linked to, which is what makes a blocklist workable: each
 * one can be dropped without knowing anything about the site. A parameter that
 * some site might legitimately use — `ref`, `tag`, `source`, `id` — is
 * deliberately absent, however often it also carries tracking, because removing
 * it can land the reader somewhere other than where the link pointed.
 */
export const TRACKING_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  // Share-sheet ids. YouTube's `si` and `is` say who passed the link along, not
  // which video it is; Spotify uses `si` the same way.
  "si",
  "is",
  // Ad click ids. Each is stamped on by the ad network at click time.
  "gclid",
  "gclsrc",
  "dclid",
  "wbraid",
  "gbraid",
  "fbclid",
  "igshid",
  "msclkid",
  "twclid",
  "ttclid",
  "li_fat_id",
  "rdt_cid",
  "epik",
  "yclid",
  "_openstat",
  "s_kwcid",
  "irclickid",
  "cjevent",
  // Email platforms, stamped per recipient — these identify the reader.
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "hsctatracking",
  "mkt_tok",
  "vero_id",
  "vero_conv",
  "oly_anon_id",
  "oly_enc_id",
  "ck_subscriber_id",
]);

/**
 * Reads a query-segment name back into the text that was written.
 *
 * `+` stands for a space in a query string, and a lone `%` or a truncated escape
 * makes `decodeURIComponent` throw. A name that will not decode cannot be one of
 * the names below, so it comes back as it was and its segment is kept.
 */
function decodeParameterName(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return raw;
  }
}

function isTrackingParameter(segment: string): boolean {
  const separator = segment.indexOf("=");
  // With no `=` the whole segment is the name: `?utm_source` is still a tag.
  const name = decodeParameterName(
    separator === -1 ? segment : segment.slice(0, separator)
  ).toLowerCase();
  return name.startsWith(TRACKING_PARAMETER_PREFIX) || TRACKING_PARAMETER_NAMES.has(name);
}

/**
 * Returns `value` without its tracking parameters, unchanged when it carries
 * none.
 *
 * A value that does not parse is returned as it came in, so that validation is
 * what refuses it and can say why. Deciding a URL is unusable is not this
 * function's job.
 */
export function stripTrackingParams(value: string): string {
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
  const kept = beforeHash
    .slice(queryIndex + 1)
    .split("&")
    .filter((segment) => !isTrackingParameter(segment));
  // The "?" only earns its place while something follows it, so a query that was
  // empty to begin with, or is empty once the trackers are gone, takes it along.
  const query = kept.some((segment) => segment.length > 0) ? `?${kept.join("&")}` : "";
  return beforeHash.slice(0, queryIndex) + query + fragment;
}
