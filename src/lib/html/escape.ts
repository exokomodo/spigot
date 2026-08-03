/**
 * HTML escaping.
 *
 * Deliberately separate from `escapeXml` in the RSS library rather than shared:
 * the two look alike but differ where it matters. `escapeXml` emits `&apos;` for
 * an apostrophe, which is an XML predefined entity but was never part of HTML 4
 * — older parsers render it literally, and a literal `'` inside a single quoted
 * attribute is an escape hatch. `&#39;` is a numeric reference, so every parser
 * reads it the same way. Sharing one function would silently couple the feed
 * output format to the page output format, and a change made for one would land
 * on the other.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes text for interpolation into HTML.
 *
 * Covers both text nodes and quoted attribute values: `<` and `&` close a text
 * node, and both quote characters close an attribute, so escaping all five
 * leaves nothing that can break out of either position. Unquoted attributes are
 * not safe under any escaping — every template here quotes its attributes.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}
