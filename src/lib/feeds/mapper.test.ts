import { describe, expect, it } from "vitest";
import { renderFeed } from "../rss/index.js";
import { isCdata } from "../rss/xml.js";
import { parseCategories, parseTimestamp, toRssChannel, toRssItem } from "./mapper.js";
import { EntryRow, FeedRow } from "./repository.js";

const FEED: FeedRow = {
  id: 1,
  slug: "tech",
  title: "Tech",
  description: "Technology news",
  link: "https://example.test/",
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

const ENTRY: EntryRow = {
  id: 1,
  feed_id: 1,
  guid: "entry-1",
  guid_is_permalink: 0,
  url: "https://example.test/1",
  title: "First",
  description: "A summary",
  content: null,
  author: null,
  categories: null,
  enclosure_url: null,
  enclosure_type: null,
  enclosure_length: null,
  published_at: "2026-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("parseTimestamp", () => {
  it("parses an ISO 8601 timestamp", () => {
    expect(parseTimestamp("2026-01-01T00:00:00.000Z")?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z"
    );
  });

  it("maps NULL to undefined", () => {
    expect(parseTimestamp(null)).toBeUndefined();
  });

  it("treats an unparseable timestamp as absent rather than throwing", () => {
    expect(parseTimestamp("not a date")).toBeUndefined();
    expect(parseTimestamp("")).toBeUndefined();
  });
});

describe("parseCategories", () => {
  it("splits a comma separated list", () => {
    expect(parseCategories("news,tech")).toEqual([{ name: "news" }, { name: "tech" }]);
  });

  it("trims whitespace and drops blanks", () => {
    expect(parseCategories(" news , , tech ")).toEqual([{ name: "news" }, { name: "tech" }]);
  });

  it("maps NULL and an empty string to no categories", () => {
    expect(parseCategories(null)).toEqual([]);
    expect(parseCategories("")).toEqual([]);
  });
});

describe("toRssItem", () => {
  it("maps the columns onto the RSS fields", () => {
    const item = toRssItem(ENTRY);
    expect(item.title).toBe("First");
    expect(item.link).toBe("https://example.test/1");
    expect(item.guid).toEqual({ value: "entry-1", isPermaLink: false });
    expect(item.pubDate?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("converts the 0/1 permalink column to a boolean", () => {
    expect(toRssItem({ ...ENTRY, guid_is_permalink: 1 }).guid?.isPermaLink).toBe(true);
    expect(toRssItem({ ...ENTRY, guid_is_permalink: 0 }).guid?.isPermaLink).toBe(false);
  });

  it("maps NULL columns to undefined so the renderer omits them", () => {
    const item = toRssItem({ ...ENTRY, description: null, author: null, published_at: null });
    expect(item.description).toBeUndefined();
    expect(item.author).toBeUndefined();
    expect(item.pubDate).toBeUndefined();
  });

  it("emits the body as CDATA, since entries carry markup", () => {
    const description = toRssItem(ENTRY).description;
    expect(description !== undefined && isCdata(description)).toBe(true);
  });

  it("falls back to content when there is no description", () => {
    const item = toRssItem({ ...ENTRY, description: null, content: "<p>Full text</p>" });
    expect(item.description).toEqual({ cdata: "<p>Full text</p>" });
  });

  it("keeps a bad timestamp from sinking the item", () => {
    const item = toRssItem({ ...ENTRY, published_at: "definitely not a date" });
    expect(item.pubDate).toBeUndefined();
    expect(item.title).toBe("First");
  });

  it("builds an enclosure when every part is present", () => {
    const item = toRssItem({
      ...ENTRY,
      enclosure_url: "https://example.test/a.mp3",
      enclosure_type: "audio/mpeg",
      enclosure_length: 1234,
    });
    expect(item.enclosure).toEqual({
      url: "https://example.test/a.mp3",
      type: "audio/mpeg",
      length: 1234,
    });
  });

  it("drops a partial enclosure", () => {
    const missingType = toRssItem({ ...ENTRY, enclosure_url: "https://a", enclosure_length: 1 });
    const missingLength = toRssItem({
      ...ENTRY,
      enclosure_url: "https://a",
      enclosure_type: "a/b",
    });
    const missingUrl = toRssItem({ ...ENTRY, enclosure_type: "a/b", enclosure_length: 1 });
    expect(missingType.enclosure).toBeUndefined();
    expect(missingLength.enclosure).toBeUndefined();
    expect(missingUrl.enclosure).toBeUndefined();
  });
});

describe("toRssChannel", () => {
  it("maps the feed columns onto the channel", () => {
    const channel = toRssChannel(FEED, []);
    expect(channel.title).toBe("Tech");
    expect(channel.link).toBe("https://example.test/");
    expect(channel.description).toBe("Technology news");
  });

  it("maps NULL columns to undefined", () => {
    const channel = toRssChannel(FEED, []);
    expect(channel.language).toBeUndefined();
    expect(channel.ttl).toBeUndefined();
    expect(channel.image).toBeUndefined();
    expect(channel.lastBuildDate).toBeUndefined();
  });

  it("carries optional metadata through when present", () => {
    const channel = toRssChannel(
      {
        ...FEED,
        language: "en-us",
        ttl_minutes: 60,
        webmaster: "web@example.test",
        managing_editor: "editor@example.test",
        category: "news,tech",
        last_built_at: "2026-02-01T00:00:00.000Z",
      },
      []
    );
    expect(channel.language).toBe("en-us");
    expect(channel.ttl).toBe(60);
    expect(channel.webMaster).toBe("web@example.test");
    expect(channel.managingEditor).toBe("editor@example.test");
    expect(channel.categories).toEqual([{ name: "news" }, { name: "tech" }]);
    expect(channel.lastBuildDate?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("borrows the channel title and link for the image", () => {
    const channel = toRssChannel({ ...FEED, image_url: "https://example.test/i.png" }, []);
    expect(channel.image).toEqual({
      url: "https://example.test/i.png",
      title: "Tech",
      link: "https://example.test/",
    });
  });

  it("prefers the stored feed URL as the self link", () => {
    const channel = toRssChannel({ ...FEED, feed_url: "https://example.test/rss.xml" }, [], {
      selfLink: "https://spigot.test/feeds/tech.xml",
    });
    expect(channel.selfLink).toBe("https://example.test/rss.xml");
  });

  it("falls back to the request URL for the self link", () => {
    const channel = toRssChannel(FEED, [], { selfLink: "https://spigot.test/feeds/tech.xml" });
    expect(channel.selfLink).toBe("https://spigot.test/feeds/tech.xml");
  });

  it("falls back to the self link for a feed with no site of its own", () => {
    const channel = toRssChannel({ ...FEED, link: null }, [], {
      selfLink: "https://spigot.test/feeds/tech.xml",
    });
    // <link> is required by RSS 2.0, so it has to resolve to something.
    expect(channel.link).toBe("https://spigot.test/feeds/tech.xml");
  });

  it("renders end to end into valid looking RSS", () => {
    const xml = renderFeed(toRssChannel(FEED, [ENTRY]));
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain("<title>Tech</title>");
    expect(xml).toContain("<title>First</title>");
    expect(xml).toContain('<guid isPermaLink="false">entry-1</guid>');
    expect(xml).toContain("<pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>");
  });

  it("escapes hostile feed content", () => {
    const xml = renderFeed(
      toRssChannel({ ...FEED, title: "Tom & Jerry <Best>" }, [
        { ...ENTRY, description: "breaks ]]> out" },
      ])
    );
    expect(xml).toContain("<title>Tom &amp; Jerry &lt;Best&gt;</title>");
    expect(xml).not.toContain("breaks ]]> out");
  });
});
