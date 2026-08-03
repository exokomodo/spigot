import { EntryRow, FeedRow, FeedSummaryRow } from "./repository.js";

/**
 * The JSON representation of a feed.
 *
 * Deliberately not the raw row: camelCase names, `null` collapsed to omitted
 * keys, and the feed's own URL included so a client never has to know how to
 * build one. Keeping it separate also means a column rename is not
 * automatically a breaking API change.
 */
export interface FeedJson {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly link?: string;
  readonly language?: string;
  readonly feedUrl: string;
  readonly entryCount?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Path a feed's RSS is served from, relative to the site root. */
export function feedPath(slug: string): string {
  return `/feeds/${slug}.xml`;
}

/** Path a feed's browsable page is served from. */
export function feedPagePath(slug: string): string {
  return `/feeds/${slug}`;
}

/**
 * The JSON representation of an entry. Same reasoning as {@link FeedJson}:
 * camelCase, nulls omitted rather than sent, decoupled from the column names.
 */
export interface EntryJson {
  readonly id: number;
  readonly feedId: number;
  readonly guid: string;
  readonly guidIsPermalink: boolean;
  readonly url: string;
  readonly title: string;
  readonly description?: string;
  readonly author?: string;
  readonly categories?: string;
  readonly enclosure?: {
    readonly url: string;
    readonly type: string;
    readonly length: number;
  };
  readonly publishedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function omitNull<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export function toFeedJson(row: FeedRow, entryCount?: number): FeedJson {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    link: omitNull(row.link),
    language: omitNull(row.language),
    feedUrl: feedPath(row.slug),
    entryCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toFeedSummaryJson(row: FeedSummaryRow): FeedJson {
  return toFeedJson(row, row.entry_count);
}

export function toEntryJson(row: EntryRow): EntryJson {
  const enclosure =
    row.enclosure_url === null || row.enclosure_type === null || row.enclosure_length === null
      ? undefined
      : { url: row.enclosure_url, type: row.enclosure_type, length: row.enclosure_length };
  return {
    id: row.id,
    feedId: row.feed_id,
    guid: row.guid,
    guidIsPermalink: row.guid_is_permalink === 1,
    url: row.url,
    title: row.title,
    description: omitNull(row.description),
    author: omitNull(row.author),
    categories: omitNull(row.categories),
    enclosure,
    publishedAt: omitNull(row.published_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
