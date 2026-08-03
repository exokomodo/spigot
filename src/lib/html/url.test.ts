import { describe, expect, it } from "vitest";
import { isSafeHttpUrl } from "./url.js";

describe("isSafeHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isSafeHttpUrl("http://example.test/a")).toBe(true);
    expect(isSafeHttpUrl("https://example.test/a")).toBe(true);
  });

  it("keeps query strings and fragments", () => {
    expect(isSafeHttpUrl("https://example.test/a?x=1&y=2#z")).toBe(true);
  });

  it("rejects javascript:", () => {
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
  });

  /*
   * The evasions all rely on a reader that compares strings. `URL` normalizes
   * the way a browser does — lowercasing the scheme, dropping leading
   * whitespace and stripping embedded tabs and newlines — so each of these
   * resolves to the same protocol the browser would actually act on.
   */
  it.each([
    ["uppercase", "JAVASCRIPT:alert(1)"],
    ["mixed case", "JaVaScRiPt:alert(1)"],
    ["leading space", " javascript:alert(1)"],
    ["embedded tab", "java\tscript:alert(1)"],
    ["embedded newline", "java\nscript:alert(1)"],
  ])("rejects javascript: spelled with %s", (_label, value) => {
    expect(isSafeHttpUrl(value)).toBe(false);
  });

  it("rejects other executable and local schemes", () => {
    expect(isSafeHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeHttpUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects relative and protocol-relative URLs", () => {
    expect(isSafeHttpUrl("/relative/path")).toBe(false);
    expect(isSafeHttpUrl("//evil.example/x")).toBe(false);
  });

  it("rejects anything that is not a URL", () => {
    expect(isSafeHttpUrl("")).toBe(false);
    expect(isSafeHttpUrl("   ")).toBe(false);
    expect(isSafeHttpUrl("not a url at all")).toBe(false);
  });
});
