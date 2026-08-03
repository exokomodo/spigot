import { FeedRow, FeedSummaryRow } from "./repository.js";

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

/** Path a feed is served from, relative to the site root. */
export function feedPath(slug: string): string {
  return `/feeds/${slug}.xml`;
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
