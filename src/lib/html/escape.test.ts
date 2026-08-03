import { describe, expect, it } from "vitest";
import { escapeHtml } from "./escape.js";

describe("escapeHtml", () => {
  it("escapes the three characters that break a text node", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("escapes both quote characters, which break attributes", () => {
    expect(escapeHtml(`"double" and 'single'`)).toBe("&quot;double&quot; and &#39;single&#39;");
  });

  it("uses a numeric reference for the apostrophe rather than &apos;", () => {
    // &apos; is an XML entity that HTML 4 never defined, so older parsers show
    // it literally -- which would put a real ' back inside a quoted attribute.
    expect(escapeHtml("'")).toBe("&#39;");
    expect(escapeHtml("'")).not.toContain("apos");
  });

  it("neutralizes a script tag", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("neutralizes an attribute breakout payload", () => {
    expect(escapeHtml(`" onerror="alert(1)`)).toBe("&quot; onerror=&quot;alert(1)");
  });

  it("escapes an existing entity's ampersand, so nothing is double-decoded", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("Tech Weekly: episode 42")).toBe("Tech Weekly: episode 42");
  });

  it("returns an empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});
