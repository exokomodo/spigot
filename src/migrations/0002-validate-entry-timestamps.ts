import { Migration } from "../lib/migration.js";

/**
 * Constrains entry timestamps to values SQLite can actually parse.
 *
 * `published_at` was TEXT with nothing checking it, and the feed sorts on it in
 * SQL — before any application code sees the value. `ORDER BY published_at DESC`
 * compares text, so a row holding `'not-a-date'` sorts above every ISO
 * timestamp ('n' > '2') and pins itself to the top of the feed for every
 * subscriber. NULL was already fine: SQLite sorts it below everything, so
 * undated entries land last. Only malformed non-null values bite.
 *
 * Enforcing it here rather than in the query keeps the sort on the
 * `(feed_id, published_at DESC)` index — a defensive `ORDER BY` expression
 * would not.
 *
 * `datetime(X) IS NOT NULL` is the parse test: SQLite returns NULL for anything
 * it cannot read, and it does accept the `strftime('%Y-%m-%dT%H:%M:%fZ')` output
 * this schema stores, trailing `Z` and fractional seconds included.
 *
 * SQLite cannot add a constraint to an existing table, so the table is rebuilt.
 * Rows that already violate the new constraint are normalized during the copy
 * rather than failing the migration: an unparseable `published_at` becomes NULL,
 * which is what the renderer already does with it at render time.
 */
const ValidateEntryTimestamps: Migration = {
  version: 2,
  name: "validate-entry-timestamps",
  up: `
CREATE TABLE IF NOT EXISTS entries_rebuilt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL REFERENCES feeds (id) ON DELETE CASCADE ON UPDATE CASCADE,
  guid TEXT NOT NULL,
  guid_is_permalink INTEGER NOT NULL DEFAULT 0 CHECK (guid_is_permalink IN (0, 1)),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  content TEXT,
  author TEXT,
  categories TEXT,
  enclosure_url TEXT,
  enclosure_type TEXT,
  enclosure_length INTEGER,
  published_at TEXT CHECK (published_at IS NULL OR datetime(published_at) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (datetime(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (datetime(updated_at) IS NOT NULL),
  UNIQUE (feed_id, guid)
);

INSERT INTO entries_rebuilt (
  id, feed_id, guid, guid_is_permalink, url, title, description, content, author,
  categories, enclosure_url, enclosure_type, enclosure_length, published_at,
  created_at, updated_at
)
SELECT
  id, feed_id, guid, guid_is_permalink, url, title, description, content, author,
  categories, enclosure_url, enclosure_type, enclosure_length,
  -- An unreadable publication date is dropped, matching the renderer.
  CASE WHEN datetime(published_at) IS NULL THEN NULL ELSE published_at END,
  -- The bookkeeping columns are NOT NULL, so they fall back to now instead.
  CASE
    WHEN datetime(created_at) IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE created_at
  END,
  CASE
    WHEN datetime(updated_at) IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE updated_at
  END
FROM entries;

DROP TABLE entries;

ALTER TABLE entries_rebuilt RENAME TO entries;

CREATE INDEX IF NOT EXISTS entries_feed_id_published_at_idx
  ON entries (feed_id, published_at DESC);

CREATE INDEX IF NOT EXISTS entries_feed_id_url_idx
  ON entries (feed_id, url);
`,
};

export default ValidateEntryTimestamps;
