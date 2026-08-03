import { Migration } from "../lib/migration.js";

/**
 * Feeds and their entries.
 *
 * Entries are deliberately owned by exactly one feed: the same underlying item
 * (a video, an article) syndicated into two feeds is two rows, so each feed can
 * publish it under its own date, title and guid. Uniqueness is therefore scoped
 * to `(feed_id, guid)` and never to `url` on its own.
 *
 * Timestamps are ISO 8601 UTC strings, which sort lexicographically and are the
 * same shape SQLite's own date functions emit.
 */
const InitialSchema: Migration = {
  version: 1,
  name: "initial-schema",
  up: `
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  link TEXT,
  feed_url TEXT,
  language TEXT,
  copyright TEXT,
  managing_editor TEXT,
  webmaster TEXT,
  category TEXT,
  generator TEXT,
  image_url TEXT,
  ttl_minutes INTEGER,
  last_built_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS entries (
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
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (feed_id, guid)
);

CREATE INDEX IF NOT EXISTS entries_feed_id_published_at_idx
  ON entries (feed_id, published_at DESC);

CREATE INDEX IF NOT EXISTS entries_feed_id_url_idx
  ON entries (feed_id, url);
`,
};

export default InitialSchema;
