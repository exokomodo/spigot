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

/** A feed row plus how many entries it holds, for the listing. */
export interface FeedSummaryRow extends FeedRow {
  readonly entry_count: number;
}

/** The columns a caller may set when creating a feed. */
export interface NewFeed {
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
  readonly language?: string;
}

/**
 * The columns a caller may set when creating an entry.
 *
 * `publishedAt` is required rather than optional: the service defaults it to
 * now, and making that explicit here keeps the decision in one place instead of
 * splitting it between this layer and the column default.
 */
export interface NewEntry {
  readonly feedId: number;
  readonly guid: string;
  readonly guidIsPermalink: boolean;
  readonly url: string;
  readonly title: string;
  readonly description?: string;
  readonly author?: string;
  readonly categories?: string;
  readonly enclosureUrl?: string;
  readonly enclosureType?: string;
  readonly enclosureLength?: number;
  readonly publishedAt: string;
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

/**
 * Every feed with its entry count, newest first.
 *
 * One grouped query rather than a count per feed: a LEFT JOIN keeps feeds that
 * have no entries yet, which are exactly the feeds someone has just created and
 * most wants to see in the listing.
 */
export async function listFeedSummaries(db: Database): Promise<readonly FeedSummaryRow[]> {
  return db.instance.all<FeedSummaryRow[]>(
    `SELECT feeds.*, COUNT(entries.id) AS entry_count
       FROM feeds
       LEFT JOIN entries ON entries.feed_id = feeds.id
      GROUP BY feeds.id
      ORDER BY feeds.created_at DESC, feeds.id DESC`
  );
}

/** Raised when a slug is already taken, so callers can answer 409 rather than 500. */
export class DuplicateSlugError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`A feed with the slug "${slug}" already exists`);
    this.name = "DuplicateSlugError";
    this.slug = slug;
  }
}

/**
 * True for the UNIQUE violation on `feeds.slug`.
 *
 * Narrow on purpose: a NOT NULL or CHECK failure is also a constraint error but
 * means something else entirely, and answering 409 for those would report a bug
 * in this code as a caller mistake.
 */
function isDuplicateSlugViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed:\s*feeds\.slug/i.test(error.message);
}

/**
 * Inserts a feed and returns the stored row.
 *
 * The duplicate check is the INSERT itself rather than a SELECT beforehand: a
 * pre-check races another request between the read and the write, while the
 * UNIQUE index cannot be raced.
 */
export async function createFeed(db: Database, feed: NewFeed): Promise<FeedRow> {
  const inserted = await db.instance
    .run(
      `INSERT INTO feeds (slug, title, description, link, language)
       VALUES (?, ?, ?, ?, ?)`,
      [feed.slug, feed.title, feed.description ?? "", feed.link ?? null, feed.language ?? null]
    )
    .catch((error: unknown) => {
      if (isDuplicateSlugViolation(error)) {
        throw new DuplicateSlugError(feed.slug);
      }
      throw error;
    });

  const created = await db.instance.get<FeedRow>("SELECT * FROM feeds WHERE id = ?", [
    inserted.lastID,
  ]);
  if (created === undefined) {
    throw new Error(`Feed ${String(inserted.lastID)} vanished immediately after being created`);
  }
  return created;
}

/** Raised when a guid is already used within the feed, so callers can answer 409. */
export class DuplicateGuidError extends Error {
  readonly guid: string;

  constructor(guid: string) {
    super(`An entry with the guid "${guid}" already exists in this feed`);
    this.name = "DuplicateGuidError";
    this.guid = guid;
  }
}

/**
 * True for the composite UNIQUE violation on `(feed_id, guid)`.
 *
 * SQLite names both columns in the message, so the pattern matches the pair
 * rather than `guid` alone — a future single-column index on `guid` would mean
 * something different and should not be reported as this.
 */
function isDuplicateGuidViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:\s*entries\.feed_id,\s*entries\.guid/i.test(error.message)
  );
}

/**
 * Inserts an entry and returns the stored row.
 *
 * As with feeds, the duplicate check is the INSERT rather than a SELECT
 * beforehand: the UNIQUE index cannot be raced, a pre-check can.
 *
 * `published_at` is expected to already be a value SQLite can parse — migration
 * 0002 constrains the column, so an unvalidated value would surface here as a
 * CHECK violation and a 500. Validating it is the service's job, and
 * {@link parseNewEntry} does it.
 */
export async function createEntry(db: Database, entry: NewEntry): Promise<EntryRow> {
  const inserted = await db.instance
    .run(
      `INSERT INTO entries (
         feed_id, guid, guid_is_permalink, url, title, description, author,
         categories, enclosure_url, enclosure_type, enclosure_length, published_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.feedId,
        entry.guid,
        entry.guidIsPermalink ? 1 : 0,
        entry.url,
        entry.title,
        entry.description ?? null,
        entry.author ?? null,
        entry.categories ?? null,
        entry.enclosureUrl ?? null,
        entry.enclosureType ?? null,
        entry.enclosureLength ?? null,
        entry.publishedAt,
      ]
    )
    .catch((error: unknown) => {
      if (isDuplicateGuidViolation(error)) {
        throw new DuplicateGuidError(entry.guid);
      }
      throw error;
    });

  const created = await db.instance.get<EntryRow>("SELECT * FROM entries WHERE id = ?", [
    inserted.lastID,
  ]);
  if (created === undefined) {
    throw new Error(`Entry ${String(inserted.lastID)} vanished immediately after being created`);
  }
  return created;
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
