import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../database.js";
import {
  DuplicateGuidError,
  NewEntry,
  createEntry,
  createFeed,
  deleteEntryById,
  findEntriesByFeedId,
  findEntryById,
  updateEntry,
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

describe("findEntryById", () => {
  it("returns the row for an id in the feed", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const entry = await createEntry(db, newEntry(feed.id));

    expect(await findEntryById(db, feed.id, entry.id)).toMatchObject({ id: entry.id, guid: "g1" });
  });

  it("returns undefined for an id that names nothing", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    expect(await findEntryById(db, feed.id, 999)).toBeUndefined();
  });

  /* Ids are unique table-wide, so the feed has to constrain the read too. */
  it("refuses an id that belongs to a different feed", async () => {
    const db = await boot();
    const one = await createFeed(db, { slug: "one", title: "One" });
    const two = await createFeed(db, { slug: "two", title: "Two" });
    const entry = await createEntry(db, newEntry(two.id));

    expect(await findEntryById(db, one.id, entry.id)).toBeUndefined();
  });
});

describe("updateEntry", () => {
  it("writes the named columns and returns the stored row", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const entry = await createEntry(db, newEntry(feed.id));

    const updated = await updateEntry(db, feed.id, entry.id, {
      title: "Renamed",
      url: "https://example.test/b",
    });

    expect(updated).toMatchObject({ title: "Renamed", url: "https://example.test/b" });
  });

  /* The whole point of a patch: a caller holding four fields has to leave the rest. */
  it("leaves columns the caller did not name alone", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const entry = await createEntry(
      db,
      newEntry(feed.id, {
        author: "Ada",
        categories: "rust,web",
        enclosureUrl: "https://example.test/a.mp3",
        enclosureType: "audio/mpeg",
        enclosureLength: 1234,
      })
    );

    const updated = await updateEntry(db, feed.id, entry.id, { title: "Renamed" });

    expect(updated).toMatchObject({
      title: "Renamed",
      author: "Ada",
      categories: "rust,web",
      enclosure_url: "https://example.test/a.mp3",
      enclosure_length: 1234,
    });
  });

  it("clears a column named with null", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const entry = await createEntry(db, newEntry(feed.id, { author: "Ada" }));

    expect(await updateEntry(db, feed.id, entry.id, { author: null })).toMatchObject({
      author: null,
    });
  });

  it("moves updated_at forward without touching created_at", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const entry = await createEntry(db, newEntry(feed.id));
    await db.instance.run("UPDATE entries SET updated_at = ? WHERE id = ?", [
      "2020-01-01T00:00:00.000Z",
      entry.id,
    ]);

    const updated = await updateEntry(db, feed.id, entry.id, { title: "Renamed" });

    expect(updated?.updated_at).not.toBe("2020-01-01T00:00:00.000Z");
    expect(updated?.created_at).toBe(entry.created_at);
  });

  it("reports undefined for an id that names nothing", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    expect(await updateEntry(db, feed.id, 999, { title: "Renamed" })).toBeUndefined();
  });

  /* The same defensive scoping as deleteEntryById, for the same reason. */
  it("refuses an id that belongs to a different feed, and changes nothing", async () => {
    const db = await boot();
    const one = await createFeed(db, { slug: "one", title: "One" });
    const two = await createFeed(db, { slug: "two", title: "Two" });
    const entry = await createEntry(db, newEntry(two.id));

    expect(await updateEntry(db, one.id, entry.id, { title: "Renamed" })).toBeUndefined();
    expect(await findEntryById(db, two.id, entry.id)).toMatchObject({ title: "A post" });
  });

  it("raises DuplicateGuidError when the new guid is already used in the feed", async () => {
    const db = await boot();
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    await createEntry(db, newEntry(feed.id, { guid: "taken" }));
    const entry = await createEntry(db, newEntry(feed.id, { guid: "mine" }));

    await expect(updateEntry(db, feed.id, entry.id, { guid: "taken" })).rejects.toBeInstanceOf(
      DuplicateGuidError
    );
  });

  it("allows a guid already used in another feed", async () => {
    const db = await boot();
    const one = await createFeed(db, { slug: "one", title: "One" });
    const two = await createFeed(db, { slug: "two", title: "Two" });
    await createEntry(db, newEntry(one.id, { guid: "shared" }));
    const entry = await createEntry(db, newEntry(two.id, { guid: "mine" }));

    expect(await updateEntry(db, two.id, entry.id, { guid: "shared" })).toMatchObject({
      guid: "shared",
    });
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
