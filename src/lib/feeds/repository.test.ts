import * as sqlite from "sqlite";
import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../database.js";
import {
  DEFAULT_ENTRY_LIMIT,
  findEntriesByFeedId,
  findFeedBySlug,
  findFeedWithEntries,
} from "./repository.js";

const opened: sqlite.Database[] = [];

/** An in-memory database wired up exactly the way the application boots. */
const openMigrated = async (): Promise<Database> => {
  const database = await loadDatabase(":memory:");
  opened.push(database.instance);
  return database;
};

afterEach(async () => {
  await Promise.all(opened.splice(0).map((instance) => instance.close()));
});

const insertFeed = async (db: Database, slug: string): Promise<number> => {
  const result = await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", [
    slug,
    `Feed ${slug}`,
  ]);
  return result.lastID as number;
};

const insertEntry = (
  db: Database,
  feedId: number,
  guid: string,
  publishedAt: string | null
): Promise<unknown> =>
  db.instance.run(
    "INSERT INTO entries (feed_id, guid, url, title, published_at) VALUES (?, ?, ?, ?, ?)",
    [feedId, guid, `https://example.test/${guid}`, `Entry ${guid}`, publishedAt]
  );

describe("findFeedBySlug", () => {
  it("finds a feed by its slug", async () => {
    const db = await openMigrated();
    await insertFeed(db, "tech");
    const feed = await findFeedBySlug(db, "tech");
    expect(feed?.slug).toBe("tech");
    expect(feed?.title).toBe("Feed tech");
  });

  it("returns undefined for an unknown slug", async () => {
    const db = await openMigrated();
    await insertFeed(db, "tech");
    expect(await findFeedBySlug(db, "nope")).toBeUndefined();
  });

  it("does not interpret the slug as SQL", async () => {
    const db = await openMigrated();
    await insertFeed(db, "tech");
    expect(await findFeedBySlug(db, "' OR 1=1 --")).toBeUndefined();
    // The table is still there, so the quote was bound rather than executed.
    expect(await findFeedBySlug(db, "tech")).toBeDefined();
  });
});

describe("findEntriesByFeedId", () => {
  it("returns entries newest first", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db, "tech");
    await insertEntry(db, feedId, "old", "2026-01-01T00:00:00.000Z");
    await insertEntry(db, feedId, "new", "2026-03-01T00:00:00.000Z");
    await insertEntry(db, feedId, "middle", "2026-02-01T00:00:00.000Z");
    const entries = await findEntriesByFeedId(db, feedId);
    expect(entries.map((entry) => entry.guid)).toEqual(["new", "middle", "old"]);
  });

  it("sorts entries without a publication date last", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db, "tech");
    await insertEntry(db, feedId, "undated", null);
    await insertEntry(db, feedId, "dated", "2026-01-01T00:00:00.000Z");
    const entries = await findEntriesByFeedId(db, feedId);
    expect(entries.map((entry) => entry.guid)).toEqual(["dated", "undated"]);
  });

  it("breaks ties on identical dates by newest row first", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db, "tech");
    await insertEntry(db, feedId, "first", "2026-01-01T00:00:00.000Z");
    await insertEntry(db, feedId, "second", "2026-01-01T00:00:00.000Z");
    const entries = await findEntriesByFeedId(db, feedId);
    expect(entries.map((entry) => entry.guid)).toEqual(["second", "first"]);
  });

  it("returns only the requested feed's entries", async () => {
    const db = await openMigrated();
    const tech = await insertFeed(db, "tech");
    const food = await insertFeed(db, "food");
    await insertEntry(db, tech, "tech-1", "2026-01-01T00:00:00.000Z");
    await insertEntry(db, food, "food-1", "2026-01-01T00:00:00.000Z");
    const entries = await findEntriesByFeedId(db, tech);
    expect(entries.map((entry) => entry.guid)).toEqual(["tech-1"]);
  });

  it("honours an explicit limit", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db, "tech");
    await insertEntry(db, feedId, "a", "2026-01-01T00:00:00.000Z");
    await insertEntry(db, feedId, "b", "2026-02-01T00:00:00.000Z");
    await insertEntry(db, feedId, "c", "2026-03-01T00:00:00.000Z");
    const entries = await findEntriesByFeedId(db, feedId, 2);
    expect(entries.map((entry) => entry.guid)).toEqual(["c", "b"]);
  });

  it("caps at the default limit", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db, "tech");
    for (let index = 0; index < DEFAULT_ENTRY_LIMIT + 5; index += 1) {
      await insertEntry(db, feedId, `entry-${index}`, "2026-01-01T00:00:00.000Z");
    }
    expect(await findEntriesByFeedId(db, feedId)).toHaveLength(DEFAULT_ENTRY_LIMIT);
  });

  it("returns an empty list for a feed with no entries", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db, "empty");
    expect(await findEntriesByFeedId(db, feedId)).toEqual([]);
  });
});

describe("findFeedWithEntries", () => {
  it("loads a feed together with its entries", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db, "tech");
    await insertEntry(db, feedId, "one", "2026-01-01T00:00:00.000Z");
    const loaded = await findFeedWithEntries(db, "tech");
    expect(loaded?.feed.slug).toBe("tech");
    expect(loaded?.entries.map((entry) => entry.guid)).toEqual(["one"]);
  });

  it("returns undefined for an unknown slug", async () => {
    const db = await openMigrated();
    expect(await findFeedWithEntries(db, "nope")).toBeUndefined();
  });
});
