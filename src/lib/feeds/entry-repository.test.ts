import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../database.js";
import {
  DuplicateGuidError,
  NewEntry,
  createEntry,
  createFeed,
  deleteEntryById,
  findEntriesByFeedId,
} from "./repository.js";

const databases: Database[] = [];

async function boot(): Promise<Database> {
  const db = await loadDatabase(":memory:");
  databases.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.instance.close()));
});

function newEntry(feedId: number, overrides: Partial<NewEntry> = {}): NewEntry {
  return {
    feedId,
    guid: "g1",
    guidIsPermalink: true,
    url: "https://example.test/a",
    title: "A post",
    publishedAt: "2026-01-15T08:30:05.000Z",
    ...overrides,
  };
}

describe("createEntry", () => {
  it("stores an entry and returns the row", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const entry = await createEntry(db, newEntry(feed.id));
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.feed_id).toBe(feed.id);
    expect(entry.url).toBe("https://example.test/a");
    expect(entry.guid_is_permalink).toBe(1);
  });

  it("stores an explicit non-permalink guid as 0", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const entry = await createEntry(db, newEntry(feed.id, { guidIsPermalink: false }));
    expect(entry.guid_is_permalink).toBe(0);
  });

  it("leaves absent optional columns NULL rather than empty strings", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const entry = await createEntry(db, newEntry(feed.id));
    expect(entry.description).toBeNull();
    expect(entry.author).toBeNull();
    expect(entry.enclosure_url).toBeNull();
  });

  it("raises DuplicateGuidError for a repeated guid in the same feed", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    await createEntry(db, newEntry(feed.id));
    await expect(
      createEntry(db, newEntry(feed.id, { url: "https://example.test/b" }))
    ).rejects.toBeInstanceOf(DuplicateGuidError);
  });

  /* The requirement from issue #13: one item syndicated into two feeds is two rows. */
  it("allows the same guid and url in a different feed", async () => {
    const db = await boot();
    const one = await createFeed(db, { slug: "one", title: "One" });
    const two = await createFeed(db, { slug: "two", title: "Two" });
    await createEntry(db, newEntry(one.id));
    const other = await createEntry(
      db,
      newEntry(two.id, { publishedAt: "2026-02-01T00:00:00.000Z" })
    );
    expect(other.feed_id).toBe(two.id);
    expect(other.published_at).toBe("2026-02-01T00:00:00.000Z");
  });

  it("rejects an entry for a feed that does not exist", async () => {
    const db = await boot();
    await expect(createEntry(db, newEntry(999))).rejects.toThrow(/FOREIGN KEY/i);
  });

  /*
   * Guards the seam between the service and the schema: migration 0002
   * constrains this column, so an unvalidated value arrives as a CHECK
   * violation. The service is what stops that happening, and this asserts the
   * constraint really is there to be tripped.
   */
  it("still refuses an unparseable published_at at the database level", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    await expect(createEntry(db, newEntry(feed.id, { publishedAt: "not-a-date" }))).rejects.toThrow(
      /CHECK constraint failed/i
    );
  });

  it("orders entries newest first, undated last", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    await createEntry(
      db,
      newEntry(feed.id, { guid: "old", publishedAt: "2026-01-01T00:00:00.000Z" })
    );
    await createEntry(
      db,
      newEntry(feed.id, { guid: "new", publishedAt: "2026-06-01T00:00:00.000Z" })
    );
    const entries = await findEntriesByFeedId(db, feed.id);
    expect(entries.map((row) => row.guid)).toEqual(["new", "old"]);
  });
});

describe("deleteEntryById", () => {
  it("removes the entry and reports that it did", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const entry = await createEntry(db, newEntry(feed.id));

    expect(await deleteEntryById(db, feed.id, entry.id)).toBe(true);
    expect(await findEntriesByFeedId(db, feed.id)).toEqual([]);
  });

  it("leaves the feed's other entries alone", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const doomed = await createEntry(db, newEntry(feed.id, { guid: "doomed" }));
    await createEntry(db, newEntry(feed.id, { guid: "kept", url: "https://example.test/b" }));

    await deleteEntryById(db, feed.id, doomed.id);

    expect((await findEntriesByFeedId(db, feed.id)).map((row) => row.guid)).toEqual(["kept"]);
  });

  it("reports false for an id that names nothing", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    expect(await deleteEntryById(db, feed.id, 999)).toBe(false);
  });

  /* The reason `feed_id` is in the WHERE clause: ids are unique table-wide. */
  it("refuses an id that belongs to a different feed", async () => {
    const db = await boot();
    const one = await createFeed(db, { slug: "one", title: "One" });
    const two = await createFeed(db, { slug: "two", title: "Two" });
    const entry = await createEntry(db, newEntry(two.id));

    expect(await deleteEntryById(db, one.id, entry.id)).toBe(false);
    expect(await findEntriesByFeedId(db, two.id)).toHaveLength(1);
  });

  it("leaves the feed itself standing", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const entry = await createEntry(db, newEntry(feed.id));

    await deleteEntryById(db, feed.id, entry.id);

    expect(await db.instance.get("SELECT count(*) AS n FROM feeds")).toMatchObject({ n: 1 });
  });
});
