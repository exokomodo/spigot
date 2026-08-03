import { describe, expect, it } from "vitest";
import {
  XML_DECLARATION,
  cdata,
  escapeXml,
  isCdata,
  renderCdata,
  renderXmlDocument,
  renderXmlElement,
  renderXmlText,
} from "./xml.js";

describe("escapeXml", () => {
  it("escapes every predefined entity", () => {
    expect(escapeXml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("escapes ampersands before the entities they introduce", () => {
    expect(escapeXml("Tom & Jerry <b>")).toBe("Tom &amp; Jerry &lt;b&gt;");
  });

  it("does not double escape an existing entity", () => {
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves text without special characters untouched", () => {
    expect(escapeXml("plain text 123")).toBe("plain text 123");
  });

  it("escapes every occurrence, not just the first", () => {
    expect(escapeXml("a & b & c")).toBe("a &amp; b &amp; c");
  });

  it("leaves non-ASCII characters as is", () => {
    expect(escapeXml("café — naïve ✓")).toBe("café — naïve ✓");
  });
});

describe("cdata", () => {
  it("marks a value as CDATA", () => {
    expect(isCdata(cdata("<p>hi</p>"))).toBe(true);
  });

  it("does not mark a plain string as CDATA", () => {
    expect(isCdata("<p>hi</p>")).toBe(false);
  });
});

describe("renderCdata", () => {
  it("wraps content without escaping it", () => {
    expect(renderCdata("<p>Tom & Jerry</p>")).toBe("<![CDATA[<p>Tom & Jerry</p>]]>");
  });

  it("splits a literal section terminator across two sections", () => {
    expect(renderCdata("a ]]> b")).toBe("<![CDATA[a ]]]]><![CDATA[> b]]>");
  });

  it("splits every section terminator", () => {
    expect(renderCdata("]]>]]>")).toBe("<![CDATA[]]]]><![CDATA[>]]]]><![CDATA[>]]>");
  });
});

describe("renderXmlText", () => {
  it("escapes plain strings", () => {
    expect(renderXmlText("a & b")).toBe("a &amp; b");
  });

  it("wraps CDATA values", () => {
    expect(renderXmlText(cdata("a & b"))).toBe("<![CDATA[a & b]]>");
  });
});

describe("renderXmlElement", () => {
  it("self closes an element with no content", () => {
    expect(renderXmlElement({ name: "atom:link", attributes: { rel: "self" } })).toBe(
      '<atom:link rel="self" />'
    );
  });

  it("renders escaped text content", () => {
    expect(renderXmlElement({ name: "title", text: "Fish & <Chips>" })).toBe(
      "<title>Fish &amp; &lt;Chips&gt;</title>"
    );
  });

  it("escapes attribute values", () => {
    expect(
      renderXmlElement({ name: "enclosure", attributes: { url: "https://x.test/a?b=1&c=2" } })
    ).toBe('<enclosure url="https://x.test/a?b=1&amp;c=2" />');
  });

  it("escapes quotes inside attribute values", () => {
    expect(renderXmlElement({ name: "source", attributes: { url: 'a"b' } })).toBe(
      '<source url="a&quot;b" />'
    );
  });

  it("omits undefined attributes", () => {
    expect(
      renderXmlElement({ name: "category", text: "news", attributes: { domain: undefined } })
    ).toBe("<category>news</category>");
  });

  it("renders numeric and boolean attributes", () => {
    expect(
      renderXmlElement({ name: "guid", text: "1", attributes: { isPermaLink: false, length: 12 } })
    ).toBe('<guid isPermaLink="false" length="12">1</guid>');
  });

  it("indents nested children", () => {
    const xml = renderXmlElement({
      name: "channel",
      children: [
        { name: "title", text: "Feed" },
        { name: "image", children: [{ name: "url", text: "https://x.test/i.png" }] },
      ],
    });
    expect(xml).toBe(
      [
        "<channel>",
        "  <title>Feed</title>",
        "  <image>",
        "    <url>https://x.test/i.png</url>",
        "  </image>",
        "</channel>",
      ].join("\n")
    );
  });

  it("prefers children over text when both are present", () => {
    expect(
      renderXmlElement({ name: "a", text: "ignored", children: [{ name: "b", text: "kept" }] })
    ).toBe(["<a>", "  <b>kept</b>", "</a>"].join("\n"));
  });

  it("renders an empty string as an empty element body", () => {
    expect(renderXmlElement({ name: "title", text: "" })).toBe("<title></title>");
  });

  it("indents from the requested depth", () => {
    expect(renderXmlElement({ name: "title", text: "Feed" }, 2)).toBe("    <title>Feed</title>");
  });
});

describe("renderXmlDocument", () => {
  it("prefixes the declaration and ends with a newline", () => {
    expect(renderXmlDocument({ name: "rss", attributes: { version: "2.0" } })).toBe(
      `${XML_DECLARATION}\n<rss version="2.0" />\n`
    );
  });
});
