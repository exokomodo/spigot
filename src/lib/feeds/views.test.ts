import { describe, expect, it } from "vitest";
import { EntryRow, FeedRow, FeedSummaryRow } from "./repository.js";
import {
  formatPublishedAt,
  renderEntryRow,
  renderFeedPage,
  renderFeedRow,
  renderFeedRows,
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
    const html = renderEntryRow("tech", entry()).html;
    expect(html).toContain('href="https://example.test/a"');
    expect(html).toContain("A post");
    expect(html).toContain("2026-01-15 08:30:05 UTC");
  });

  it("renders the body as text, since entry markup comes from elsewhere", () => {
    const html = renderEntryRow(
      "tech",
      entry({ description: "<b>bold</b> & <script>alert(1)</script>" })
    ).html;
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("falls back to content when there is no description", () => {
    expect(renderEntryRow("tech", entry({ content: "the content" })).html).toContain("the content");
  });

  it("does not link an entry whose stored URL is not http(s)", () => {
    const html = renderEntryRow("tech", entry({ url: "javascript:alert(1)" })).html;
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

  it("lists entries and advertises the RSS to the browser", () => {
    const html = renderFeedPage(feed, [entry()]);
    expect(html).toContain("A post");
    expect(html).toContain('rel="alternate" type="application/rss+xml"');
    expect(html).toContain('href="/feeds/tech.xml"');
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

const summary = (overrides: Partial<FeedSummaryRow> = {}): FeedSummaryRow => ({
  ...feed,
  entry_count: 0,
  ...overrides,
});

describe("the RSS copy button", () => {
  it("copies the feed address instead of navigating to it", () => {
    const html = renderFeedRow(summary()).html;
    expect(html).toContain('data-copy="/feeds/tech.xml"');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('<a href="/feeds/tech.xml"');
  });

  it("names the feed, since the visible label is only the word RSS", () => {
    expect(renderFeedRow(summary()).html).toContain(
      'aria-label="Copy the RSS address for Tech Weekly"'
    );
  });

  /* The title is stored, and it reaches a quoted attribute here. */
  it("escapes a title that would otherwise break out of the label attribute", () => {
    const html = renderFeedRow(summary({ title: '" onmouseover="alert(1)' })).html;
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
  });

  it("appears once per feed and not at all in the empty state", () => {
    const rows = renderFeedRows([summary(), summary({ slug: "food", title: "Food" })]).html;
    expect(rows.match(/data-copy=/g)).toHaveLength(2);
    expect(renderFeedRows([]).html).not.toContain("data-copy");
  });

  it("stands where the RSS link used to on the feed page", () => {
    expect(renderFeedPage(feed, [])).toContain('data-copy="/feeds/tech.xml"');
  });

  it.each([
    ["the listing page", () => renderIndexPage([summary()])],
    ["a feed page", () => renderFeedPage(feed, [])],
  ])("ships the copy behaviour and its live region with %s", (_name, renderPage) => {
    const html = renderPage();
    expect(html).toContain('id="copy-status"');
    expect(html).toContain('role="status"');
    expect(html).toContain("navigator.clipboard");
  });

  /* Rows arrive by htmx swap after load, so a listener bound per button would die with them. */
  it("binds the handler on the document rather than on each button", () => {
    const html = renderIndexPage([summary()]);
    expect(html).toContain('document.addEventListener("click"');
    expect(html).not.toContain("onclick=");
  });
});

describe("the feed delete button", () => {
  it("deletes the feed's own path and refreshes the table body", () => {
    const html = renderFeedRow(summary()).html;
    expect(html).toContain('hx-delete="/feeds/tech"');
    expect(html).toContain('hx-target="#feed-rows"');
    expect(html).toContain('hx-swap="innerHTML"');
  });

  it("asks first, and says the entries go too", () => {
    const html = renderFeedRow(summary()).html;
    expect(html).toContain(
      'hx-confirm="Delete the feed &quot;Tech Weekly&quot;? This also deletes its entries."'
    );
  });

  it("has a name, since it is an icon with no text", () => {
    expect(renderFeedRow(summary()).html).toContain('aria-label="Delete the feed Tech Weekly"');
  });

  /* The title is a stored value, and it reaches two attributes here. */
  it("escapes a title that would otherwise break out of the confirm attribute", () => {
    const html = renderFeedRow(summary({ title: '" onmouseover="alert(1)' })).html;
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
  });

  it("escapes a script payload in the title rather than emitting it in the confirm", () => {
    const html = renderFeedRow(summary({ title: "<script>alert(1)</script>" })).html;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("appears once per feed and not at all in the empty state", () => {
    const rows = renderFeedRows([summary(), summary({ slug: "food", title: "Food" })]).html;
    expect(rows.match(/hx-delete=/g)).toHaveLength(2);
    expect(renderFeedRows([]).html).not.toContain("hx-delete");
  });

  it("is reachable from the rendered index page", () => {
    expect(renderIndexPage([summary()])).toContain('hx-delete="/feeds/tech"');
  });
});

describe("the entry delete button", () => {
  it("deletes the entry's own path under its feed and refreshes the list", () => {
    const html = renderEntryRow("tech", entry({ id: 42 })).html;
    expect(html).toContain('hx-delete="/feeds/tech/entries/42"');
    expect(html).toContain('hx-target="#entry-list"');
  });

  it("asks first, naming the entry", () => {
    const html = renderEntryRow("tech", entry()).html;
    expect(html).toContain('hx-confirm="Delete the entry &quot;A post&quot;?"');
    expect(html).toContain('aria-label="Delete the entry A post"');
  });

  it("escapes an entry title in the confirmation", () => {
    const html = renderEntryRow("tech", entry({ title: '" onmouseover="alert(1)' })).html;
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
  });

  /* The slug reaches an attribute as part of the URL, like every other value. */
  it("escapes the slug it was handed", () => {
    const html = renderEntryRow('" onmouseover="alert(1)', entry()).html;
    expect(html).not.toContain('onmouseover="alert(1)"');
  });

  it("is absent from the empty state", () => {
    expect(renderFeedPage(feed, [])).not.toContain("hx-delete");
  });
});
