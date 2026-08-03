import { toRfc822 } from "./date.js";
import { XmlAttributes, XmlElement, XmlText, renderXmlDocument } from "./xml.js";

const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";

/** Text that is either escaped inline or emitted as CDATA via `cdata()`. */
export type RssText = XmlText;

export interface RssCategory {
  readonly name: string;
  /** A string identifying the taxonomy the category belongs to. */
  readonly domain?: string;
}

export interface RssEnclosure {
  readonly url: string;
  /** Size of the media object, in bytes. */
  readonly length: number;
  /** MIME type of the media object, e.g. `audio/mpeg`. */
  readonly type: string;
}

export interface RssGuid {
  readonly value: string;
  /**
   * Whether readers may treat `value` as a URL. Omitted from the output when
   * undefined, which the spec reads as `true`.
   */
  readonly isPermaLink?: boolean;
}

export interface RssImage {
  readonly url: string;
  readonly title: string;
  readonly link: string;
  readonly width?: number;
  readonly height?: number;
  readonly description?: string;
}

export interface RssSource {
  readonly title: string;
  readonly url: string;
}

export interface RssItem {
  readonly title?: string;
  readonly link?: string;
  readonly description?: RssText;
  readonly author?: string;
  readonly categories?: readonly RssCategory[];
  readonly comments?: string;
  readonly enclosure?: RssEnclosure;
  readonly guid?: RssGuid;
  readonly pubDate?: Date;
  readonly source?: RssSource;
}

export interface RssChannel {
  readonly title: string;
  readonly link: string;
  readonly description: RssText;
  readonly language?: string;
  readonly copyright?: string;
  readonly managingEditor?: string;
  readonly webMaster?: string;
  readonly pubDate?: Date;
  readonly lastBuildDate?: Date;
  readonly categories?: readonly RssCategory[];
  readonly generator?: string;
  /** URL of the documentation for the format used in the feed. */
  readonly docs?: string;
  /** Minutes the feed may be cached before refreshing. */
  readonly ttl?: number;
  readonly image?: RssImage;
  /** Canonical URL of this feed, emitted as `<atom:link rel="self">`. */
  readonly selfLink?: string;
  readonly items?: readonly RssItem[];
}

function element(name: string, text: RssText, attributes?: XmlAttributes): XmlElement {
  return { name, text, attributes };
}

/** Emits nothing for an absent value, so optional fields stay out of the output. */
function optional(
  name: string,
  value: RssText | number | undefined,
  attributes?: XmlAttributes
): readonly XmlElement[] {
  if (value === undefined) {
    return [];
  }
  return [element(name, typeof value === "number" ? String(value) : value, attributes)];
}

function optionalDate(name: string, value: Date | undefined): readonly XmlElement[] {
  return value === undefined ? [] : [element(name, toRfc822(value))];
}

function categoryElements(categories: readonly RssCategory[] | undefined): readonly XmlElement[] {
  return (categories ?? []).map((category) =>
    element("category", category.name, { domain: category.domain })
  );
}

function imageElements(image: RssImage | undefined): readonly XmlElement[] {
  if (image === undefined) {
    return [];
  }
  return [
    {
      name: "image",
      children: [
        element("url", image.url),
        element("title", image.title),
        element("link", image.link),
        ...optional("width", image.width),
        ...optional("height", image.height),
        ...optional("description", image.description),
      ],
    },
  ];
}

function selfLinkElements(selfLink: string | undefined): readonly XmlElement[] {
  if (selfLink === undefined) {
    return [];
  }
  return [
    {
      name: "atom:link",
      attributes: { href: selfLink, rel: "self", type: "application/rss+xml" },
    },
  ];
}

function guidElements(guid: RssGuid | undefined): readonly XmlElement[] {
  if (guid === undefined) {
    return [];
  }
  return [element("guid", guid.value, { isPermaLink: guid.isPermaLink })];
}

function enclosureElements(enclosure: RssEnclosure | undefined): readonly XmlElement[] {
  if (enclosure === undefined) {
    return [];
  }
  return [
    {
      name: "enclosure",
      attributes: {
        url: enclosure.url,
        length: enclosure.length,
        type: enclosure.type,
      },
    },
  ];
}

function sourceElements(source: RssSource | undefined): readonly XmlElement[] {
  return source === undefined ? [] : [element("source", source.title, { url: source.url })];
}

/** Builds the `<item>` element for a single entry. */
export function itemElement(item: RssItem): XmlElement {
  return {
    name: "item",
    children: [
      ...optional("title", item.title),
      ...optional("link", item.link),
      ...optional("description", item.description),
      ...optional("author", item.author),
      ...categoryElements(item.categories),
      ...optional("comments", item.comments),
      ...enclosureElements(item.enclosure),
      ...guidElements(item.guid),
      ...optionalDate("pubDate", item.pubDate),
      ...sourceElements(item.source),
    ],
  };
}

/** Builds the `<rss>` root element for a channel and its items. */
export function feedElement(channel: RssChannel): XmlElement {
  const children: readonly XmlElement[] = [
    element("title", channel.title),
    element("link", channel.link),
    element("description", channel.description),
    ...optional("language", channel.language),
    ...optional("copyright", channel.copyright),
    ...optional("managingEditor", channel.managingEditor),
    ...optional("webMaster", channel.webMaster),
    ...optionalDate("pubDate", channel.pubDate),
    ...optionalDate("lastBuildDate", channel.lastBuildDate),
    ...categoryElements(channel.categories),
    ...optional("generator", channel.generator),
    ...optional("docs", channel.docs),
    ...optional("ttl", channel.ttl),
    ...imageElements(channel.image),
    ...selfLinkElements(channel.selfLink),
    ...(channel.items ?? []).map(itemElement),
  ];
  return {
    name: "rss",
    attributes: {
      version: "2.0",
      "xmlns:atom": channel.selfLink === undefined ? undefined : ATOM_NAMESPACE,
    },
    children: [{ name: "channel", children }],
  };
}

/** Renders a channel as a complete RSS 2.0 document. */
export function renderFeed(channel: RssChannel): string {
  return renderXmlDocument(feedElement(channel));
}
