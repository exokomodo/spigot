import { describe, expect, it } from "vitest";
import { stripQueryString } from "./strip-query.js";
import { isSafeHttpUrl } from "./url.js";

describe("stripQueryString", () => {
  it("removes a query string", () => {
    expect(stripQueryString("https://example.test/a?utm_source=newsletter")).toBe(
      "https://example.test/a"
    );
  });

  /* The point of dropping the whole query rather than named parameters. */
  it("removes parameters it has never heard of", () => {
    expect(stripQueryString("https://youtu.be/dQw4w9WgXcQ?si=abc123&t=42")).toBe(
      "https://youtu.be/dQw4w9WgXcQ"
    );
    expect(stripQueryString("https://example.test/a?id=7&page=2&sort=desc")).toBe(
      "https://example.test/a"
    );
  });

  it("leaves a URL with no query alone", () => {
    expect(stripQueryString("https://example.test/a")).toBe("https://example.test/a");
    expect(stripQueryString("https://example.test")).toBe("https://example.test");
  });

  it("removes an empty query", () => {
    expect(stripQueryString("https://example.test/a?")).toBe("https://example.test/a");
  });

  it("keeps the fragment", () => {
    expect(stripQueryString("https://example.test/a#section-3")).toBe(
      "https://example.test/a#section-3"
    );
    expect(stripQueryString("https://example.test/a?utm_source=x#section-3")).toBe(
      "https://example.test/a#section-3"
    );
  });

  /* A "?" after the "#" belongs to the fragment, so there is no query to remove. */
  it("leaves a question mark inside a fragment alone", () => {
    expect(stripQueryString("https://example.test/a#/route?tab=two")).toBe(
      "https://example.test/a#/route?tab=two"
    );
    expect(stripQueryString("https://example.test/a?utm=x#/route?tab=two")).toBe(
      "https://example.test/a#/route?tab=two"
    );
  });

  /*
   * Rejecting a URL is validation's job, not this function's. Handing back the
   * input unchanged is what lets the caller report why it was refused.
   */
  it("leaves something that is not a URL untouched", () => {
    expect(stripQueryString("not a url?x=1")).toBe("not a url?x=1");
    expect(stripQueryString("/relative/path?x=1")).toBe("/relative/path?x=1");
    expect(stripQueryString("")).toBe("");
  });

  /*
   * A dangerous scheme still parses, so it is stripped like anything else and
   * stays dangerous. Which schemes are allowed is `isSafeHttpUrl`'s decision,
   * and stripping neither makes a URL safe nor is a place to re-check it.
   */
  it("does not launder a javascript: URL", () => {
    expect(stripQueryString("javascript:alert(1)?x=1")).toBe("javascript:alert(1)");
    expect(isSafeHttpUrl(stripQueryString("javascript:alert(1)?x=1"))).toBe(false);
  });

  /*
   * `URL.toString()` would rewrite all of these. Stripping is not normalizing:
   * a URL that comes back different in ways nobody asked for is worse than one
   * that kept a parameter.
   */
  it.each([
    ["host case", "https://Example.TEST/a?x=1", "https://Example.TEST/a"],
    ["path case", "https://example.test/A/B?x=1", "https://example.test/A/B"],
    ["a default port", "https://example.test:443/a?x=1", "https://example.test:443/a"],
    ["a missing trailing slash", "https://example.test?x=1", "https://example.test"],
    ["a trailing slash", "https://example.test/a/?x=1", "https://example.test/a/"],
    ["percent-encoding", "https://example.test/a%2Fb?x=1", "https://example.test/a%2Fb"],
  ])("does not normalize %s", (_label, value, expected) => {
    expect(stripQueryString(value)).toBe(expected);
  });

  it("leaves http URLs alone in the same way as https", () => {
    expect(stripQueryString("http://example.test/a?x=1")).toBe("http://example.test/a");
  });
});
