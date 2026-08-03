import sqlite3 from "sqlite3";
import * as sqlite from "sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadDatabase } from "./database.js";
import { Migration, runMigrations } from "./migration.js";
import migrations from "../migrations/index.js";

const opened: sqlite.Database[] = [];

/** An empty in-memory database, with no migrations applied. */
const open = async (): Promise<sqlite.Database> => {
  const instance = await sqlite.open({ filename: ":memory:", driver: sqlite3.Database });
  await instance.exec("PRAGMA foreign_keys = ON;");
  opened.push(instance);
  return instance;
};

/** An in-memory database wired up exactly the way the application boots. */
const openMigrated = async (): Promise<sqlite.Database> => {
  const database = await loadDatabase(":memory:");
  opened.push(database.instance);
  return database.instance;
};

afterEach(async () => {
  await Promise.all(opened.splice(0).map((instance) => instance.close()));
});

const insertFeed = (db: sqlite.Database, slug: string) =>
  db.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", [slug, `Feed ${slug}`]);

const insertEntry = (
  db: sqlite.Database,
  feedId: number,
  guid: string,
  url: string,
  publishedAt: string
) =>
  db.run("INSERT INTO entries (feed_id, guid, url, title, published_at) VALUES (?, ?, ?, ?, ?)", [
    feedId,
    guid,
    url,
    `Entry ${guid}`,
    publishedAt,
  ]);

describe("runMigrations", () => {
  it("creates the schema on an empty database", async () => {
    const db = await openMigrated();
    const tables = await db.all<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(["entries", "feeds", "schema_migrations"])
    );
  });

  it("indexes entries by feed and publication date", async () => {
    const db = await openMigrated();
    const indexes = await db.all<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name"
    );
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["entries_feed_id_published_at_idx", "entries_feed_id_url_idx"])
    );
  });

  it("records every applied migration", async () => {
    const db = await open();
    const applied = await runMigrations(db);
    expect(applied).toEqual(migrations);

    const rows = await db.all<{ version: number; name: string }[]>(
      "SELECT version, name FROM schema_migrations ORDER BY version"
    );
    expect(rows).toEqual(migrations.map(({ version, name }) => ({ version, name })));
  });

  it("applies nothing on a second run", async () => {
    const db = await open();
    await runMigrations(db);

    const applied = await runMigrations(db);
    expect(applied).toEqual([]);

    const { count } = (await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM schema_migrations"
    ))!;
    expect(count).toBe(migrations.length);
  });

  it("preserves existing rows when re-run", async () => {
    const db = await open();
    await runMigrations(db);
    await insertFeed(db, "daily");
    await runMigrations(db);

    const feeds = await db.all<{ slug: string }[]>("SELECT slug FROM feeds");
    expect(feeds).toEqual([{ slug: "daily" }]);
  });

  it("applies only the migrations the database has not seen", async () => {
    const db = await open();
    await runMigrations(db, migrations);

    const later: Migration = {
      version: 9001,
      name: "add-feeds-note",
      up: "ALTER TABLE feeds ADD COLUMN note TEXT;",
    };
    const applied = await runMigrations(db, [...migrations, later]);
    expect(applied).toEqual([later]);
  });

  it("rolls back and reports a failing migration", async () => {
    const db = await open();
    const broken: Migration = {
      version: 1,
      name: "broken",
      up: "CREATE TABLE widgets (id INTEGER PRIMARY KEY); SELECT nope FROM missing_table;",
    };

    await expect(runMigrations(db, [broken])).rejects.toThrow(/Migration 1 \("broken"\) failed/);

    const objects = await db.all<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE name = 'widgets'"
    );
    expect(objects).toEqual([]);

    const rows = await db.all("SELECT version FROM schema_migrations");
    expect(rows).toEqual([]);
  });

  it("rejects migrations that are not in ascending version order", async () => {
    const db = await open();
    const outOfOrder: readonly Migration[] = [
      { version: 2, name: "second", up: "SELECT 1;" },
      { version: 1, name: "first", up: "SELECT 1;" },
    ];
    await expect(runMigrations(db, outOfOrder)).rejects.toThrow(/not ordered after/);
  });

  it("rejects duplicate migration versions", async () => {
    const db = await open();
    const duplicated: readonly Migration[] = [
      { version: 1, name: "first", up: "SELECT 1;" },
      { version: 1, name: "also-first", up: "SELECT 1;" },
    ];
    await expect(runMigrations(db, duplicated)).rejects.toThrow(/not ordered after/);
  });

  it("rejects non-positive migration versions", async () => {
    const db = await open();
    const invalid: readonly Migration[] = [{ version: 0, name: "zeroth", up: "SELECT 1;" }];
    await expect(runMigrations(db, invalid)).rejects.toThrow(/must be positive integers/);
  });
});

describe("schema", () => {
  it("enforces foreign keys on the connection", async () => {
    const db = await openMigrated();
    const row = await db.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(row?.foreign_keys).toBe(1);
  });

  it("rejects entries that point at a missing feed", async () => {
    const db = await openMigrated();
    await expect(
      insertEntry(db, 404, "guid-1", "https://example.com/a", "2026-01-01")
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("deletes entries when their feed is deleted", async () => {
    const db = await openMigrated();
    const kept = await insertFeed(db, "kept");
    const removed = await insertFeed(db, "removed");
    await insertEntry(db, kept.lastID!, "guid-1", "https://example.com/a", "2026-01-01");
    await insertEntry(db, removed.lastID!, "guid-1", "https://example.com/a", "2026-01-02");

    await db.run("DELETE FROM feeds WHERE id = ?", [removed.lastID]);

    const rows = await db.all<{ feed_id: number }[]>("SELECT feed_id FROM entries");
    expect(rows).toEqual([{ feed_id: kept.lastID }]);
  });

  it("stores the same url as separate entries in different feeds", async () => {
    const db = await openMigrated();
    const first = await insertFeed(db, "first");
    const second = await insertFeed(db, "second");
    const url = "https://example.com/video";

    await insertEntry(db, first.lastID!, "video", url, "2026-01-01T00:00:00.000Z");
    await insertEntry(db, second.lastID!, "video", url, "2026-06-01T00:00:00.000Z");

    const rows = await db.all<{ id: number; feed_id: number; published_at: string }[]>(
      "SELECT id, feed_id, published_at FROM entries WHERE url = ? ORDER BY published_at",
      [url]
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
    expect(rows.map((row) => row.published_at)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    ]);
  });

  it("rejects a duplicate guid within one feed", async () => {
    const db = await openMigrated();
    const feed = await insertFeed(db, "daily");
    await insertEntry(db, feed.lastID!, "video", "https://example.com/a", "2026-01-01");

    await expect(
      insertEntry(db, feed.lastID!, "video", "https://example.com/b", "2026-01-02")
    ).rejects.toThrow(/UNIQUE constraint failed: entries.feed_id, entries.guid/);
  });

  it("allows the same url twice in one feed under different guids", async () => {
    const db = await openMigrated();
    const feed = await insertFeed(db, "daily");
    const url = "https://example.com/video";
    await insertEntry(db, feed.lastID!, "first-airing", url, "2026-01-01");
    await insertEntry(db, feed.lastID!, "rerun", url, "2026-02-01");

    const rows = await db.all("SELECT id FROM entries WHERE url = ?", [url]);
    expect(rows).toHaveLength(2);
  });

  it("rejects a duplicate feed slug", async () => {
    const db = await openMigrated();
    await insertFeed(db, "daily");
    await expect(insertFeed(db, "daily")).rejects.toThrow(/UNIQUE constraint failed: feeds.slug/);
  });

  it("defaults feed timestamps to an ISO 8601 instant", async () => {
    const db = await openMigrated();
    await insertFeed(db, "daily");
    const feed = await db.get<{ created_at: string; updated_at: string }>(
      "SELECT created_at, updated_at FROM feeds WHERE slug = ?",
      ["daily"]
    );
    expect(feed?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(feed?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
