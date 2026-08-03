import { describe, expect, it } from "vitest";
import { SLUG_MAX_LENGTH, SLUG_PATTERN, toSlug } from "./slug.js";

describe("toSlug", () => {
  it.each([
    ["Tech Weekly", "tech-weekly"],
    ["tech", "tech"],
    ["TECH", "tech"],
    ["Tech   Weekly", "tech-weekly"],
    ["  Tech Weekly  ", "tech-weekly"],
    ["Tech Weekly — 2024!", "tech-weekly-2024"],
    ["tech_weekly", "tech-weekly"],
    ["Tech/Weekly", "tech-weekly"],
    ["tech.xml", "tech-xml"],
    ["Café Owners", "cafe-owners"],
    ["Ünder Wraps", "under-wraps"],
    ["A1", "a1"],
  ])("turns %j into %j", (name, expected) => {
    expect(toSlug(name)).toBe(expected);
  });

  it("returns nothing for a name with no letters or digits", () => {
    for (const name of ["", "   ", "!!!", "---", "🎧🎧"]) {
      expect(toSlug(name)).toBe("");
    }
  });

  it("never leaves a hyphen at either end, even after truncating", () => {
    // The cut lands on the space between the words, which would otherwise
    // survive as a trailing hyphen.
    const name = `${"a".repeat(SLUG_MAX_LENGTH)} tail`;
    expect(toSlug(name)).toBe("a".repeat(SLUG_MAX_LENGTH));
  });

  it("caps the slug at the column's length", () => {
    expect(toSlug("word ".repeat(200)).length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });

  it("produces a URL-safe slug for anything that produces one at all", () => {
    const names = [
      "Tech Weekly",
      "  spaced  out  ",
      "Punctuation!?!",
      "Café — Owners",
      "MiXeD CaSe 123",
      "a".repeat(SLUG_MAX_LENGTH + 50),
      "x".repeat(SLUG_MAX_LENGTH - 1) + " y",
      "x'); DROP TABLE feeds; --",
      "../../etc/passwd",
      "%2e%2e",
      "<script>alert(1)</script>",
    ];
    for (const name of names) {
      const slug = toSlug(name);
      expect(slug, name).not.toBe("");
      expect(slug, name).toMatch(SLUG_PATTERN);
      expect(encodeURIComponent(slug), name).toBe(slug);
    }
  });
});
