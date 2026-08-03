import Database from "../database.js";

/**
 * Row shapes are a faithful mirror of the schema: snake_case names, and `null`
 * wherever the column is nullable. Translating them into the RSS view models is
 * the mapper's job, so the two never have to agree on anything but the columns.
 */
export interface FeedRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly link: string | null;
  readonly feed_url: string | null;
  readonly language: string | null;
  readonly copyright: string | null;
  readonly managing_editor: string | null;
  readonly webmaster: string | null;
  readonly category: string | null;
  readonly generator: string | null;
  readonly image_url: string | null;
  readonly ttl_minutes: number | null;
  readonly last_built_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface EntryRow {
  readonly id: number;
  readonly feed_id: number;
  readonly guid: string;
  readonly guid_is_permalink: number;
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly content: string | null;
  readonly author: string | null;
  readonly categories: string | null;
  readonly enclosure_url: string | null;
  readonly enclosure_type: string | null;
  readonly enclosure_length: number | null;
  readonly published_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A feed and the entries that belong to it, in the order they should render. */
export interface FeedWithEntries {
  readonly feed: FeedRow;
  readonly entries: readonly EntryRow[];
}

/** How many entries a feed serves when the caller does not say otherwise. */
export const DEFAULT_ENTRY_LIMIT = 50;

export async function findFeedBySlug(db: Database, slug: string): Promise<FeedRow | undefined> {
  return db.instance.get<FeedRow>("SELECT * FROM feeds WHERE slug = ?", [slug]);
}

/**
 * Entries for a feed, newest first.
 *
 * SQLite orders NULL below every other value, so a plain `DESC` already puts
 * undated entries last — and it keeps the query on the
 * `(feed_id, published_at DESC)` index, which an explicit `IS NULL` term would
 * not. `id DESC` breaks ties so the order is total rather than merely stable.
 */
export async function findEntriesByFeedId(
  db: Database,
  feedId: number,
  limit: number = DEFAULT_ENTRY_LIMIT
): Promise<readonly EntryRow[]> {
  return db.instance.all<EntryRow[]>(
    `SELECT * FROM entries
      WHERE feed_id = ?
      ORDER BY published_at DESC, id DESC
      LIMIT ?`,
    [feedId, limit]
  );
}

/** Loads a feed and its entries in one call, or `undefined` if the slug is unknown. */
export async function findFeedWithEntries(
  db: Database,
  slug: string,
  limit: number = DEFAULT_ENTRY_LIMIT
): Promise<FeedWithEntries | undefined> {
  const feed = await findFeedBySlug(db, slug);
  if (feed === undefined) {
    return undefined;
  }
  return {
    feed,
    entries: await findEntriesByFeedId(db, feed.id, limit),
  };
}
