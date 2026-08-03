import sqlite3 from "sqlite3";
import * as sqlite from "sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadDatabase } from "../lib/database.js";
import { runMigrations } from "../lib/migration.js";
import InitialSchema from "./0001-initial-schema.js";
import ValidateEntryTimestamps from "./0002-validate-entry-timestamps.js";

const opened: sqlite.Database[] = [];

const track = (instance: sqlite.Database): sqlite.Database => {
  opened.push(instance);
  return instance;
};

/** A database with every migration applied, exactly as the application boots. */
const openMigrated = async (): Promise<sqlite.Database> =>
  track((await loadDatabase(":memory:")).instance);

/** A database frozen at migration 0001, so 0002 can be run against real data. */
const openAtInitialSchema = async (): Promise<sqlite.Database> => {
  const instance = track(await sqlite.open({ filename: ":memory:", driver: sqlite3.Database }));
  await instance.exec("PRAGMA foreign_keys = ON;");
  await runMigrations(instance, [InitialSchema]);
  return instance;
};

afterEach(async () => {
  await Promise.all(opened.splice(0).map((instance) => instance.close()));
});

const insertFeed = async (db: sqlite.Database, slug = "tech"): Promise<number> => {
  const result = await db.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", [
    slug,
    `Feed ${slug}`,
  ]);
  return result.lastID as number;
};

const insertEntry = (
  db: sqlite.Database,
  feedId: number,
  guid: string,
  publishedAt: string | null
): Promise<unknown> =>
  db.run("INSERT INTO entries (feed_id, guid, url, title, published_at) VALUES (?, ?, ?, ?, ?)", [
    feedId,
    guid,
    `https://example.test/${guid}`,
    `Entry ${guid}`,
    publishedAt,
  ]);

describe("the published_at constraint", () => {
  it("rejects a malformed publication date", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db);
    await expect(insertEntry(db, feedId, "bad", "not-a-date")).rejects.toThrow(/CHECK constraint/);
  });

  it("rejects an empty string and an impossible date", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db);
    await expect(insertEntry(db, feedId, "empty", "")).rejects.toThrow(/CHECK constraint/);
    await expect(insertEntry(db, feedId, "impossible", "2026-13-45T99:99:99.999Z")).rejects.toThrow(
      /CHECK constraint/
    );
  });

  it("accepts NULL", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db);
    await insertEntry(db, feedId, "undated", null);
    const row = await db.get<{ published_at: string | null }>(
      "SELECT published_at FROM entries WHERE guid = ?",
      ["undated"]
    );
    expect(row?.published_at).toBeNull();
  });

  it("accepts the timestamp format the schema itself writes", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db);
    // The same expression the created_at/updated_at defaults use.
    await db.run(
      `INSERT INTO entries (feed_id, guid, url, title, published_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      [feedId, "now", "https://example.test/now", "Now"]
    );
    const row = await db.get<{ published_at: string }>(
      "SELECT published_at FROM entries WHERE guid = ?",
      ["now"]
    );
    expect(row?.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("accepts an explicit ISO 8601 UTC timestamp", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db);
    await insertEntry(db, feedId, "explicit", "2026-08-03T19:39:27.123Z");
    const row = await db.get<{ published_at: string }>(
      "SELECT published_at FROM entries WHERE guid = ?",
      ["explicit"]
    );
    expect(row?.published_at).toBe("2026-08-03T19:39:27.123Z");
  });

  it("leaves the bookkeeping columns writable with their defaults", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db);
    await insertEntry(db, feedId, "defaults", null);
    const row = await db.get<{ created_at: string; updated_at: string }>(
      "SELECT created_at, updated_at FROM entries WHERE guid = ?",
      ["defaults"]
    );
    expect(row?.created_at).toMatch(/Z$/);
    expect(row?.updated_at).toMatch(/Z$/);
  });
});

describe("rebuilding entries", () => {
  it("normalizes a pre-existing bad publication date instead of failing", async () => {
    const db = await openAtInitialSchema();
    const feedId = await insertFeed(db);
    // Only possible before 0002 adds the constraint.
    await insertEntry(db, feedId, "bad", "not-a-date");
    await insertEntry(db, feedId, "good", "2026-08-02T10:00:00.000Z");

    await runMigrations(db, [InitialSchema, ValidateEntryTimestamps]);

    const rows = await db.all<{ guid: string; published_at: string | null }[]>(
      "SELECT guid, published_at FROM entries ORDER BY guid"
    );
    expect(rows).toEqual([
      { guid: "bad", published_at: null },
      { guid: "good", published_at: "2026-08-02T10:00:00.000Z" },
    ]);
  });

  it("normalizes an unreadable created_at to a usable timestamp", async () => {
    const db = await openAtInitialSchema();
    const feedId = await insertFeed(db);
    await db.run(
      `INSERT INTO entries (feed_id, guid, url, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [feedId, "rotten", "https://example.test/rotten", "Rotten", "garbage", "garbage"]
    );

    await runMigrations(db, [InitialSchema, ValidateEntryTimestamps]);

    const row = await db.get<{ created_at: string; updated_at: string }>(
      "SELECT created_at, updated_at FROM entries WHERE guid = ?",
      ["rotten"]
    );
    expect(row?.created_at).toMatch(/Z$/);
    expect(row?.updated_at).toMatch(/Z$/);
  });

  it("preserves the rows and their ids", async () => {
    const db = await openAtInitialSchema();
    const feedId = await insertFeed(db);
    await insertEntry(db, feedId, "one", "2026-08-01T10:00:00.000Z");
    await insertEntry(db, feedId, "two", "2026-08-02T10:00:00.000Z");
    const before = await db.all<{ id: number; guid: string }[]>(
      "SELECT id, guid FROM entries ORDER BY id"
    );

    await runMigrations(db, [InitialSchema, ValidateEntryTimestamps]);

    const after = await db.all<{ id: number; guid: string }[]>(
      "SELECT id, guid FROM entries ORDER BY id"
    );
    expect(after).toEqual(before);
  });

  it("recreates both indexes", async () => {
    const db = await openMigrated();
    const indexes = await db.all<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entries' ORDER BY name"
    );
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["entries_feed_id_published_at_idx", "entries_feed_id_url_idx"])
    );
  });

  it("leaves no rebuild scaffolding behind", async () => {
    const db = await openMigrated();
    const tables = await db.all<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%rebuilt%'"
    );
    expect(tables).toEqual([]);
  });

  it("keeps the per-feed guid uniqueness constraint", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db);
    await insertEntry(db, feedId, "dupe", null);
    await expect(insertEntry(db, feedId, "dupe", null)).rejects.toThrow(/UNIQUE constraint/);
  });

  it("still allows the same url in two different feeds", async () => {
    const db = await openMigrated();
    const tech = await insertFeed(db, "tech");
    const food = await insertFeed(db, "food");
    await db.run(
      "INSERT INTO entries (feed_id, guid, url, title, published_at) VALUES (?, ?, ?, ?, ?)",
      [tech, "shared", "https://example.test/shared", "Shared", "2026-08-01T00:00:00.000Z"]
    );
    await db.run(
      "INSERT INTO entries (feed_id, guid, url, title, published_at) VALUES (?, ?, ?, ?, ?)",
      [food, "shared", "https://example.test/shared", "Shared", "2026-08-05T00:00:00.000Z"]
    );
    const rows = await db.all<{ published_at: string }[]>(
      "SELECT published_at FROM entries WHERE url = ? ORDER BY published_at",
      ["https://example.test/shared"]
    );
    expect(rows).toHaveLength(2);
  });

  it("keeps the delete cascade from feeds", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db);
    await insertEntry(db, feedId, "one", "2026-08-01T10:00:00.000Z");
    await db.run("DELETE FROM feeds WHERE id = ?", [feedId]);
    const remaining = await db.all("SELECT id FROM entries");
    expect(remaining).toEqual([]);
  });

  it("still rejects an entry pointing at no feed", async () => {
    const db = await openMigrated();
    await expect(insertEntry(db, 999, "orphan", null)).rejects.toThrow(/FOREIGN KEY constraint/);
  });

  it("is a no-op when run a second time", async () => {
    const db = await openMigrated();
    const applied = await runMigrations(db);
    expect(applied).toEqual([]);
  });
});

describe("feed ordering with the constraint in place", () => {
  it("returns entries newest first with undated last", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db);
    await insertEntry(db, feedId, "older", "2026-07-01T10:00:00.000Z");
    await insertEntry(db, feedId, "undated", null);
    await insertEntry(db, feedId, "newest", "2026-08-02T10:00:00.000Z");

    const rows = await db.all<{ guid: string }[]>(
      "SELECT guid FROM entries WHERE feed_id = ? ORDER BY published_at DESC, id DESC",
      [feedId]
    );
    expect(rows.map((row) => row.guid)).toEqual(["newest", "older", "undated"]);
  });

  it("no longer admits the value that used to sort to the top", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db);
    await insertEntry(db, feedId, "newest", "2026-08-02T10:00:00.000Z");
    // 'n' > '2' lexicographically, so this row used to lead the feed.
    await expect(insertEntry(db, feedId, "bad", "not-a-date")).rejects.toThrow(/CHECK constraint/);
    const rows = await db.all<{ guid: string }[]>(
      "SELECT guid FROM entries WHERE feed_id = ? ORDER BY published_at DESC, id DESC",
      [feedId]
    );
    expect(rows.map((row) => row.guid)).toEqual(["newest"]);
  });
});
