/**
 * Slugs are derived, never typed. A feed's title is the only name anyone gives
 * it, and `toSlug` turns that into the identifier the URLs use, so nobody has to
 * know what a URL tolerates in order to create a feed.
 */

/**
 * A slug appears in `/feeds/<slug>.xml`, so it has to survive a URL untouched.
 * Lowercase alphanumerics in hyphen-separated groups: no leading, trailing or
 * doubled hyphens, nothing needing percent-encoding, and no case for two slugs
 * to differ only by.
 *
 * {@link toSlug} produces this shape by construction; the pattern stays as the
 * written-down definition that its tests check the output against.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SLUG_MAX_LENGTH = 100;

/**
 * Derives a URL-safe slug from a feed's name.
 *
 * Every run of characters a slug may not contain collapses to a single hyphen,
 * so "Tech Weekly — 2024!" becomes "tech-weekly-2024". Accented letters are
 * decomposed first and their marks dropped, which keeps "Café" as "cafe" rather
 * than losing the letter along with the accent.
 *
 * Returns "" when the name holds nothing that survives — a title of only emoji
 * or only punctuation, say. That is a name the caller has to fix rather than
 * something to paper over with a generated identifier, so the empty string is
 * the answer and validating it is the caller's job.
 */
export function toSlug(name: string): string {
  const unaccented = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const hyphenated = unaccented
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Truncation can land mid-word and leave the hyphen that followed it, so the
  // trailing trim happens again rather than only before the cut.
  return hyphenated.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
}
