import { describe, expect, it } from "vitest";
import { RssChannel, itemElement, renderFeed } from "./feed.js";
import { cdata, renderXmlElement } from "./xml.js";

const MINIMAL_CHANNEL: RssChannel = {
  title: "Spigot",
  link: "https://spigot.test/",
  description: "Aggregated feeds",
};

function renderItem(item: Parameters<typeof itemElement>[0]): string {
  return renderXmlElement(itemElement(item));
}

describe("renderFeed", () => {
  it("renders a minimal, valid RSS 2.0 document", () => {
    expect(renderFeed(MINIMAL_CHANNEL)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0">',
        "  <channel>",
        "    <title>Spigot</title>",
        "    <link>https://spigot.test/</link>",
        "    <description>Aggregated feeds</description>",
        "  </channel>",
        "</rss>",
        "",
      ].join("\n")
    );
  });

  it("omits every optional channel element that was not supplied", () => {
    const xml = renderFeed(MINIMAL_CHANNEL);
    for (const name of [
      "language",
      "copyright",
      "managingEditor",
      "webMaster",
      "pubDate",
      "lastBuildDate",
      "category",
      "generator",
      "docs",
      "ttl",
      "image",
      "atom:link",
      "item",
    ]) {
      expect(xml).not.toContain(`<${name}`);
    }
  });

  it("omits the atom namespace when there is no self link", () => {
    expect(renderFeed(MINIMAL_CHANNEL)).not.toContain("xmlns:atom");
  });

  it("declares the atom namespace when a self link is present", () => {
    const xml = renderFeed({ ...MINIMAL_CHANNEL, selfLink: "https://spigot.test/feed.xml" });
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(
      '<atom:link href="https://spigot.test/feed.xml" rel="self" type="application/rss+xml" />'
    );
  });

  it("escapes special characters in channel text", () => {
    const xml = renderFeed({
      ...MINIMAL_CHANNEL,
      title: "Fish & <Chips> \"quoted\" 'single'",
      link: "https://spigot.test/feed?a=1&b=2",
    });
    expect(xml).toContain(
      "<title>Fish &amp; &lt;Chips&gt; &quot;quoted&quot; &apos;single&apos;</title>"
    );
    expect(xml).toContain("<link>https://spigot.test/feed?a=1&amp;b=2</link>");
    expect(xml).not.toContain("<Chips>");
  });

  it("emits a CDATA description without escaping it", () => {
    const xml = renderFeed({
      ...MINIMAL_CHANNEL,
      description: cdata("<p>Tom & Jerry</p>"),
    });
    expect(xml).toContain("<description><![CDATA[<p>Tom & Jerry</p>]]></description>");
  });

  it("formats channel dates as RFC 822", () => {
    const xml = renderFeed({
      ...MINIMAL_CHANNEL,
      pubDate: new Date(Date.UTC(2024, 4, 6, 7, 8, 9)),
      lastBuildDate: new Date(Date.UTC(2024, 4, 7, 0, 0, 0)),
    });
    expect(xml).toContain("<pubDate>Mon, 06 May 2024 07:08:09 GMT</pubDate>");
    expect(xml).toContain("<lastBuildDate>Tue, 07 May 2024 00:00:00 GMT</lastBuildDate>");
  });

  it("renders ttl as a number", () => {
    expect(renderFeed({ ...MINIMAL_CHANNEL, ttl: 60 })).toContain("<ttl>60</ttl>");
  });

  it("renders channel categories, with and without a domain", () => {
    const xml = renderFeed({
      ...MINIMAL_CHANNEL,
      categories: [
        { name: "Technology" },
        { name: "News", domain: "https://spigot.test/taxonomy" },
      ],
    });
    expect(xml).toContain("<category>Technology</category>");
    expect(xml).toContain('<category domain="https://spigot.test/taxonomy">News</category>');
  });

  it("renders the channel image with its optional dimensions", () => {
    const xml = renderFeed({
      ...MINIMAL_CHANNEL,
      image: {
        url: "https://spigot.test/logo.png",
        title: "Spigot",
        link: "https://spigot.test/",
        width: 144,
        height: 144,
      },
    });
    expect(xml).toContain("    <image>");
    expect(xml).toContain("      <url>https://spigot.test/logo.png</url>");
    expect(xml).toContain("      <width>144</width>");
    expect(xml).toContain("      <height>144</height>");
  });

  it("omits image dimensions that were not supplied", () => {
    const xml = renderFeed({
      ...MINIMAL_CHANNEL,
      image: { url: "https://spigot.test/logo.png", title: "Spigot", link: "https://spigot.test/" },
    });
    expect(xml).not.toContain("<width>");
    expect(xml).not.toContain("<height>");
  });

  it("keeps items in the supplied order", () => {
    const xml = renderFeed({
      ...MINIMAL_CHANNEL,
      items: [{ title: "First" }, { title: "Second" }],
    });
    expect(xml.indexOf("First")).toBeLessThan(xml.indexOf("Second"));
  });

  it("propagates an invalid date as an error", () => {
    expect(() => renderFeed({ ...MINIMAL_CHANNEL, pubDate: new Date("nope") })).toThrow(RangeError);
  });
});

describe("itemElement", () => {
  it("self closes an item when nothing is supplied", () => {
    expect(renderItem({})).toBe("<item />");
  });

  it("escapes special characters in the title", () => {
    expect(renderItem({ title: "Rust & <C++>" })).toContain(
      "<title>Rust &amp; &lt;C++&gt;</title>"
    );
  });

  it("renders a permalink guid without the attribute", () => {
    expect(renderItem({ guid: { value: "https://spigot.test/1" } })).toContain(
      "<guid>https://spigot.test/1</guid>"
    );
  });

  it("renders isPermaLink when it is explicitly set", () => {
    expect(renderItem({ guid: { value: "urn:uuid:1", isPermaLink: false } })).toContain(
      '<guid isPermaLink="false">urn:uuid:1</guid>'
    );
    expect(renderItem({ guid: { value: "https://x.test/1", isPermaLink: true } })).toContain(
      '<guid isPermaLink="true">https://x.test/1</guid>'
    );
  });

  it("renders an enclosure with url, length and type", () => {
    expect(
      renderItem({
        enclosure: { url: "https://spigot.test/a.mp3?x=1&y=2", length: 12345, type: "audio/mpeg" },
      })
    ).toContain(
      '<enclosure url="https://spigot.test/a.mp3?x=1&amp;y=2" length="12345" type="audio/mpeg" />'
    );
  });

  it("renders the author and categories", () => {
    const xml = renderItem({
      author: "someone@spigot.test (A & B)",
      categories: [{ name: "R&D" }],
    });
    expect(xml).toContain("<author>someone@spigot.test (A &amp; B)</author>");
    expect(xml).toContain("<category>R&amp;D</category>");
  });

  it("renders the source with its url attribute", () => {
    expect(
      renderItem({ source: { title: "Upstream", url: "https://up.test/feed.xml" } })
    ).toContain('<source url="https://up.test/feed.xml">Upstream</source>');
  });

  it("formats the item pubDate as RFC 822", () => {
    expect(renderItem({ pubDate: new Date(Date.UTC(2002, 9, 2, 13, 0, 0)) })).toContain(
      "<pubDate>Wed, 02 Oct 2002 13:00:00 GMT</pubDate>"
    );
  });

  it("omits optional item elements that were not supplied", () => {
    const xml = renderItem({ title: "Only a title" });
    for (const name of [
      "link",
      "description",
      "author",
      "category",
      "comments",
      "enclosure",
      "guid",
      "pubDate",
      "source",
    ]) {
      expect(xml).not.toContain(`<${name}`);
    }
  });
});

describe("end to end", () => {
  it("renders a full podcast style channel", () => {
    const xml = renderFeed({
      title: "Spigot & Friends",
      link: "https://spigot.test/",
      description: cdata("<p>Everything, <em>aggregated</em>.</p>"),
      language: "en-us",
      copyright: "© 2024 Spigot",
      managingEditor: "editor@spigot.test (Ed & Co)",
      webMaster: "webmaster@spigot.test",
      pubDate: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)),
      lastBuildDate: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)),
      categories: [{ name: "Technology" }],
      generator: "spigot/0.1.0",
      docs: "https://www.rssboard.org/rss-specification",
      ttl: 60,
      image: {
        url: "https://spigot.test/logo.png",
        title: "Spigot & Friends",
        link: "https://spigot.test/",
        width: 144,
        height: 144,
        description: "The logo",
      },
      selfLink: "https://spigot.test/feed.xml",
      items: [
        {
          title: "Episode 1: <Beginnings> & Ends",
          link: "https://spigot.test/1",
          description: cdata("<p>Show notes ]]> included.</p>"),
          author: "host@spigot.test (Host)",
          categories: [{ name: "Pilot", domain: "https://spigot.test/taxonomy" }],
          comments: "https://spigot.test/1#comments",
          enclosure: {
            url: "https://spigot.test/1.mp3?token=a&b=c",
            length: 5242880,
            type: "audio/mpeg",
          },
          guid: { value: "urn:uuid:0001", isPermaLink: false },
          pubDate: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)),
          source: { title: "Upstream", url: "https://up.test/feed.xml" },
        },
      ],
    });

    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        "  <channel>",
        "    <title>Spigot &amp; Friends</title>",
        "    <link>https://spigot.test/</link>",
        "    <description><![CDATA[<p>Everything, <em>aggregated</em>.</p>]]></description>",
        "    <language>en-us</language>",
        "    <copyright>© 2024 Spigot</copyright>",
        "    <managingEditor>editor@spigot.test (Ed &amp; Co)</managingEditor>",
        "    <webMaster>webmaster@spigot.test</webMaster>",
        "    <pubDate>Tue, 02 Jan 2024 03:04:05 GMT</pubDate>",
        "    <lastBuildDate>Tue, 02 Jan 2024 03:04:05 GMT</lastBuildDate>",
        "    <category>Technology</category>",
        "    <generator>spigot/0.1.0</generator>",
        "    <docs>https://www.rssboard.org/rss-specification</docs>",
        "    <ttl>60</ttl>",
        "    <image>",
        "      <url>https://spigot.test/logo.png</url>",
        "      <title>Spigot &amp; Friends</title>",
        "      <link>https://spigot.test/</link>",
        "      <width>144</width>",
        "      <height>144</height>",
        "      <description>The logo</description>",
        "    </image>",
        '    <atom:link href="https://spigot.test/feed.xml" rel="self" type="application/rss+xml" />',
        "    <item>",
        "      <title>Episode 1: &lt;Beginnings&gt; &amp; Ends</title>",
        "      <link>https://spigot.test/1</link>",
        "      <description><![CDATA[<p>Show notes ]]]]><![CDATA[> included.</p>]]></description>",
        "      <author>host@spigot.test (Host)</author>",
        '      <category domain="https://spigot.test/taxonomy">Pilot</category>',
        "      <comments>https://spigot.test/1#comments</comments>",
        '      <enclosure url="https://spigot.test/1.mp3?token=a&amp;b=c" length="5242880" type="audio/mpeg" />',
        '      <guid isPermaLink="false">urn:uuid:0001</guid>',
        "      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>",
        '      <source url="https://up.test/feed.xml">Upstream</source>',
        "    </item>",
        "  </channel>",
        "</rss>",
        "",
      ].join("\n")
    );
  });
});
