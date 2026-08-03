import { RssCategory, RssChannel, RssEnclosure, RssImage, RssItem } from "../rss/index.js";
import { cdata } from "../rss/xml.js";
import { EntryRow, FeedRow, FeedWithEntries } from "./repository.js";

/**
 * Turns database rows into the RSS view models.
 *
 * The one rule everything else follows: a `NULL` column becomes `undefined`, so
 * the renderer omits the element entirely rather than emitting an empty one.
 */

/** `category` and `categories` are stored as a comma separated list. */
const CATEGORY_SEPARATOR = ",";

export interface MapFeedOptions {
  /**
   * Absolute URL this feed is being served from. Used for `<atom:link
   * rel="self">`, and as the `<link>` fallback for a feed with no site of its
   * own — `<link>` is required by RSS 2.0, so it has to come from somewhere.
   */
  readonly selfLink?: string;
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

/**
 * Parses a stored ISO 8601 timestamp. A column holding something unparseable is
 * treated as absent: one bad row costs its own `pubDate`, not the whole feed.
 */
export function parseTimestamp(value: string | null): Date | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Splits a stored list into categories, dropping blanks. */
export function parseCategories(value: string | null): readonly RssCategory[] {
  if (value === null) {
    return [];
  }
  return value
    .split(CATEGORY_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
}

/** An enclosure needs all three parts to be meaningful, so partial rows are dropped. */
function toEnclosure(row: EntryRow): RssEnclosure | undefined {
  if (row.enclosure_url === null || row.enclosure_type === null || row.enclosure_length === null) {
    return undefined;
  }
  return {
    url: row.enclosure_url,
    length: row.enclosure_length,
    type: row.enclosure_type,
  };
}

/**
 * The schema stores only an image URL, but RSS requires a title and link on the
 * image too, and both are conventionally the channel's own.
 */
function toImage(feed: FeedRow, link: string): RssImage | undefined {
  if (feed.image_url === null) {
    return undefined;
  }
  return { url: feed.image_url, title: feed.title, link };
}

export function toRssItem(row: EntryRow): RssItem {
  /*
   * RSS 2.0 has only <description>; the fuller `content` column is kept as a
   * fallback so a row with no summary still says something, rather than waiting
   * on content:encoded support in the renderer.
   */
  const body = row.description ?? row.content;
  return {
    title: row.title,
    link: row.url,
    // Entry bodies routinely carry markup, so they go out as CDATA.
    description: body === null ? undefined : cdata(body),
    author: optional(row.author),
    categories: parseCategories(row.categories),
    enclosure: toEnclosure(row),
    guid: { value: row.guid, isPermaLink: row.guid_is_permalink === 1 },
    pubDate: parseTimestamp(row.published_at),
  };
}

export function toRssChannel(
  feed: FeedRow,
  entries: readonly EntryRow[],
  options: MapFeedOptions = {}
): RssChannel {
  const link = feed.link ?? feed.feed_url ?? options.selfLink ?? "";
  const selfLink = feed.feed_url ?? options.selfLink;
  return {
    title: feed.title,
    link,
    description: feed.description,
    language: optional(feed.language),
    copyright: optional(feed.copyright),
    managingEditor: optional(feed.managing_editor),
    webMaster: optional(feed.webmaster),
    lastBuildDate: parseTimestamp(feed.last_built_at),
    categories: parseCategories(feed.category),
    generator: optional(feed.generator),
    ttl: optional(feed.ttl_minutes),
    image: toImage(feed, link),
    selfLink,
    items: entries.map(toRssItem),
  };
}

/** Convenience wrapper over {@link toRssChannel} for a repository result. */
export function toRssFeed(loaded: FeedWithEntries, options: MapFeedOptions = {}): RssChannel {
  return toRssChannel(loaded.feed, loaded.entries, options);
}
