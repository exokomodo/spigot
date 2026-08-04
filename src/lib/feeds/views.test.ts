import { describe, expect, it } from "vitest";
import { EntryRow, FeedRow } from "./repository.js";
import {
  formatPublishedAt,
  renderEntryRow,
  renderFeedPage,
  renderIndexPage,
  renderLink,
  renderNotFoundPage,
} from "./views.js";

const feed: FeedRow = {
  id: 1,
  slug: "tech",
  title: "Tech Weekly",
  description: "A roundup",
  link: null,
  feed_url: null,
  language: null,
  copyright: null,
  managing_editor: null,
  webmaster: null,
  category: null,
  generator: null,
  image_url: null,
  ttl_minutes: null,
  last_built_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function entry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    feed_id: 1,
    guid: "g",
    guid_is_permalink: 1,
    url: "https://example.test/a",
    title: "A post",
    description: null,
    content: null,
    author: null,
    categories: null,
    enclosure_url: null,
    enclosure_type: null,
    enclosure_length: null,
    published_at: "2026-01-15T08:30:05.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderLink", () => {
  it("links an http(s) URL", () => {
    const html = renderLink("https://example.test/a", "Read it").html;
    expect(html).toContain('href="https://example.test/a"');
    expect(html).toContain("Read it");
  });

  /*
   * The service already rejects these on the way in. This is the second line:
   * a row can reach the database by other means — a fixture, a migration, a
   * direct INSERT — and escaping does not help, because `javascript:alert(1)`
   * has nothing in it to escape.
   */
  it.each([
    ["javascript:alert(1)"],
    ["JavaScript:alert(1)"],
    ["java\tscript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["vbscript:msgbox(1)"],
  ])("does not link %s", (url) => {
    const html = renderLink(url, "Click me").html;
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
    expect(html).toContain("Click me");
  });

  it("escapes the text in both the linked and unlinked forms", () => {
    expect(renderLink("https://example.test/a", "<script>alert(1)</script>").html).not.toContain(
      "<script>"
    );
    expect(renderLink("javascript:alert(1)", "<script>alert(1)</script>").html).not.toContain(
      "<script>"
    );
  });

  it("escapes a quote in the href so it cannot break out of the attribute", () => {
    const html = renderLink('https://example.test/a"onmouseover="alert(1)', "x").html;
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain("&quot;");
  });
});

describe("formatPublishedAt", () => {
  it("formats an instant", () => {
    expect(formatPublishedAt("2026-01-15T08:30:05.000Z")).toBe("2026-01-15 08:30:05 UTC");
  });

  it("shows an em dash for a missing or unreadable value", () => {
    expect(formatPublishedAt(null)).toBe("—");
    expect(formatPublishedAt("not-a-date")).toBe("—");
  });
});

describe("renderEntryRow", () => {
  it("renders a title, link and date", () => {
    const html = renderEntryRow(entry()).html;
    expect(html).toContain('href="https://example.test/a"');
    expect(html).toContain("A post");
    expect(html).toContain("2026-01-15 08:30:05 UTC");
  });

  it("renders the body as text, since entry markup comes from elsewhere", () => {
    const html = renderEntryRow(
      entry({ description: "<b>bold</b> & <script>alert(1)</script>" })
    ).html;
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("falls back to content when there is no description", () => {
    expect(renderEntryRow(entry({ content: "the content" })).html).toContain("the content");
  });

  it("does not link an entry whose stored URL is not http(s)", () => {
    const html = renderEntryRow(entry({ url: "javascript:alert(1)" })).html;
    expect(html).not.toContain("<a ");
    expect(html).toContain("A post");
  });
});

describe("renderFeedPage", () => {
  it("shows an empty state naming the feed when there are no entries", () => {
    const html = renderFeedPage(feed, []);
    expect(html).toContain("No entries yet");
    expect(html).toContain("/api/feeds/tech/entries");
  });

  it("lists entries and links to the RSS", () => {
    const html = renderFeedPage(feed, [entry()]);
    expect(html).toContain("A post");
    expect(html).toContain("/feeds/tech.xml");
  });

  it("escapes the feed title and description", () => {
    const html = renderFeedPage(
      { ...feed, title: "<script>alert(1)</script>", description: '" onerror="alert(2)' },
      []
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not link a feed site URL that is not http(s)", () => {
    const html = renderFeedPage({ ...feed, link: "javascript:alert(1)" }, []);
    expect(html).not.toContain('href="javascript:');
  });

  it("links a feed site URL that is safe", () => {
    const html = renderFeedPage({ ...feed, link: "https://tech.example/" }, []);
    expect(html).toContain('href="https://tech.example/"');
  });

  it("omits the site link entirely when the feed has none", () => {
    expect(renderFeedPage(feed, [])).not.toContain(">Site<");
  });
});

describe("the footer", () => {
  it.each([
    ["the listing page", () => renderIndexPage([])],
    ["a feed page", () => renderFeedPage(feed, [entry()])],
    ["the 404 page", () => renderNotFoundPage("No such feed")],
  ])("links to the source from %s", (_name, renderPage) => {
    const html = renderPage();
    expect(html).toContain('href="https://github.com/exokomodo/spigot"');
    expect(html).toContain("Source on GitHub");
  });
});
