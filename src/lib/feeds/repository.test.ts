import * as sqlite from "sqlite";
import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../database.js";
import {
  DEFAULT_ENTRY_LIMIT,
  countEntriesByFeedId,
  deleteFeedBySlug,
  findEntriesByFeedId,
  findEntryIdsByTitle,
  foldForSearch,
  findFeedBySlug,
  findFeedPage,
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
  publishedAt: string | null,
  title = `Entry ${guid}`
): Promise<unknown> =>
  db.instance.run(
    "INSERT INTO entries (feed_id, guid, url, title, published_at) VALUES (?, ?, ?, ?, ?)",
    [feedId, guid, `https://example.test/${guid}`, title, publishedAt]
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

  it("skips the given offset, keeping the newest-first order", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db, "tech");
    await insertEntry(db, feedId, "a", "2026-01-01T00:00:00.000Z");
    await insertEntry(db, feedId, "b", "2026-02-01T00:00:00.000Z");
    await insertEntry(db, feedId, "c", "2026-03-01T00:00:00.000Z");
    const entries = await findEntriesByFeedId(db, feedId, 2, 2);
    expect(entries.map((entry) => entry.guid)).toEqual(["a"]);
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

describe("deleteFeedBySlug", () => {
  it("removes the feed and reports that it did", async () => {
    const db = await openMigrated();
    await insertFeed(db, "tech");
    expect(await deleteFeedBySlug(db, "tech")).toBe(true);
    expect(await findFeedBySlug(db, "tech")).toBeUndefined();
  });

  it("reports false for a slug that names nothing", async () => {
    const db = await openMigrated();
    expect(await deleteFeedBySlug(db, "nope")).toBe(false);
  });

  /*
   * The cascade is only real if the connection asked for foreign keys, which
   * `loadDatabase` does and which `openMigrated` above deliberately goes
   * through. Without the pragma this passes the delete and silently orphans
   * every entry, so this asserts the pragma as much as the schema.
   */
  it("takes the feed's entries with it", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db, "tech");
    await insertEntry(db, feedId, "one", "2026-01-01T00:00:00.000Z");
    await insertEntry(db, feedId, "two", "2026-02-01T00:00:00.000Z");

    await deleteFeedBySlug(db, "tech");

    expect(await db.instance.get("SELECT count(*) AS n FROM entries")).toMatchObject({ n: 0 });
  });

  it("leaves another feed's entries alone", async () => {
    const db = await openMigrated();
    const tech = await insertFeed(db, "tech");
    const food = await insertFeed(db, "food");
    await insertEntry(db, tech, "tech-1", "2026-01-01T00:00:00.000Z");
    await insertEntry(db, food, "food-1", "2026-01-01T00:00:00.000Z");

    await deleteFeedBySlug(db, "tech");

    expect((await findEntriesByFeedId(db, food)).map((entry) => entry.guid)).toEqual(["food-1"]);
  });

  it("does not interpret the slug as SQL", async () => {
    const db = await openMigrated();
    await insertFeed(db, "tech");
    expect(await deleteFeedBySlug(db, "' OR 1=1 --")).toBe(false);
    expect(await findFeedBySlug(db, "tech")).toBeDefined();
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

  it("loads every entry, with no cap", async () => {
    const db = await openMigrated();
    const feedId = await insertFeed(db, "tech");
    for (let index = 0; index < DEFAULT_ENTRY_LIMIT + 5; index += 1) {
      await insertEntry(db, feedId, `entry-${index}`, "2026-01-01T00:00:00.000Z");
    }
    expect((await findFeedWithEntries(db, "tech"))?.entries).toHaveLength(DEFAULT_ENTRY_LIMIT + 5);
  });
});

describe("countEntriesByFeedId", () => {
  it("counts every entry of the feed and none of another's", async () => {
    const db = await openMigrated();
    const tech = await insertFeed(db, "tech");
    const food = await insertFeed(db, "food");
    for (let index = 0; index < DEFAULT_ENTRY_LIMIT + 5; index += 1) {
      await insertEntry(db, tech, `tech-${index}`, "2026-01-01T00:00:00.000Z");
    }
    await insertEntry(db, food, "food-1", "2026-01-01T00:00:00.000Z");
    expect(await countEntriesByFeedId(db, tech)).toBe(DEFAULT_ENTRY_LIMIT + 5);
    expect(await countEntriesByFeedId(db, food)).toBe(1);
  });
});

describe("findFeedPage", () => {
  /** Five entries dated a day apart, so "e" is newest and "a" oldest. */
  const seedFive = async (db: Database): Promise<void> => {
    const feedId = await insertFeed(db, "tech");
    for (const [index, guid] of ["a", "b", "c", "d", "e"].entries()) {
      await insertEntry(db, feedId, guid, `2026-01-0${String(index + 1)}T00:00:00.000Z`);
    }
  };

  it("serves the requested page and says how many there are", async () => {
    const db = await openMigrated();
    await seedFive(db);
    const loaded = await findFeedPage(db, "tech", 2, 2);
    expect(loaded?.entries.map((entry) => entry.guid)).toEqual(["c", "b"]);
    expect(loaded).toMatchObject({ page: 2, pageCount: 3, pageSize: 2, totalEntries: 5 });
  });

  it("reaches every entry across the pages, each exactly once", async () => {
    const db = await openMigrated();
    await seedFive(db);
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const loaded = await findFeedPage(db, "tech", page, 2);
      seen.push(...(loaded?.entries.map((entry) => entry.guid) ?? []));
    }
    expect(seen).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("clamps a page past the end to the last page", async () => {
    const db = await openMigrated();
    await seedFive(db);
    const loaded = await findFeedPage(db, "tech", 99, 2);
    expect(loaded?.page).toBe(3);
    expect(loaded?.entries.map((entry) => entry.guid)).toEqual(["a"]);
  });

  it("clamps a page below 1 to the first page", async () => {
    const db = await openMigrated();
    await seedFive(db);
    expect((await findFeedPage(db, "tech", 0, 2))?.page).toBe(1);
  });

  it("gives an empty feed one empty page", async () => {
    const db = await openMigrated();
    await insertFeed(db, "tech");
    const loaded = await findFeedPage(db, "tech", 1);
    expect(loaded).toMatchObject({ page: 1, pageCount: 1, totalEntries: 0, entries: [] });
  });

  it("returns undefined for an unknown slug", async () => {
    const db = await openMigrated();
    expect(await findFeedPage(db, "nope", 1)).toBeUndefined();
  });
});

describe("foldForSearch", () => {
  it("ignores case beyond ASCII", () => {
    expect(foldForSearch("ÜBER Ærø")).toBe(foldForSearch("über ærø"));
  });

  it("treats a composed and a decomposed accent as the same letter", () => {
    expect(foldForSearch("Cafe\u0301")).toBe(foldForSearch("Caf\u00e9"));
  });

  it.each([
    ["jalapeño", "jalapeno"],
    ["JALAPEÑO", "jalapeno"],
    ["Crème brûlée", "creme brulee"],
    ["Résumé", "resume"],
    ["São Paulo", "sao paulo"],
    ["Łódź", "lodz"],
    ["Øresund", "oresund"],
    ["Straße", "strasse"],
    ["Æsir", "aesir"],
  ])("folds %j to %j", (text, folded) => {
    expect(foldForSearch(text)).toBe(folded);
  });

  it("keeps marks that change the letter in non-Latin scripts", () => {
    // が (ga) and か (ka) are different syllables, not an accented pair.
    expect(foldForSearch("が")).not.toBe(foldForSearch("か"));
    // हि and ह differ by a vowel sign.
    expect(foldForSearch("हि")).not.toBe(foldForSearch("ह"));
  });
});

describe("findEntryIdsByTitle", () => {
  const seedTitles = async (db: Database, titles: readonly string[]): Promise<number> => {
    const feedId = await insertFeed(db, "tech");
    for (const [index, title] of titles.entries()) {
      await insertEntry(
        db,
        feedId,
        `g-${String(index)}`,
        `2026-01-0${String(index + 1)}T00:00:00.000Z`,
        title
      );
    }
    return feedId;
  };

  const titlesOf = async (db: Database, ids: readonly number[]): Promise<string[]> => {
    const rows = await Promise.all(
      ids.map((id) =>
        db.instance.get<{ title: string }>("SELECT title FROM entries WHERE id = ?", [id])
      )
    );
    return rows.map((row) => row?.title ?? "");
  };

  it("matches part of a title regardless of case, newest first", async () => {
    const db = await openMigrated();
    const feedId = await seedTitles(db, ["Rust in 2026", "Go notes", "Why RUST?", "trusty tools"]);
    const ids = await findEntryIdsByTitle(db, feedId, "rust");
    expect(await titlesOf(db, ids)).toEqual(["trusty tools", "Why RUST?", "Rust in 2026"]);
  });

  it("ignores accents in either direction", async () => {
    const db = await openMigrated();
    const feedId = await seedTitles(db, ["Jalapeño poppers", "Jalapeno salsa", "Plain"]);
    expect(await titlesOf(db, await findEntryIdsByTitle(db, feedId, "jalapeno"))).toEqual([
      "Jalapeno salsa",
      "Jalapeño poppers",
    ]);
    expect(await titlesOf(db, await findEntryIdsByTitle(db, feedId, "JALAPEÑO"))).toEqual([
      "Jalapeno salsa",
      "Jalapeño poppers",
    ]);
  });

  it("matches accented titles regardless of case", async () => {
    const db = await openMigrated();
    const feedId = await seedTitles(db, ["Über alles", "Crème brûlée", "Plain"]);
    expect(await titlesOf(db, await findEntryIdsByTitle(db, feedId, "über"))).toEqual([
      "Über alles",
    ]);
    expect(await titlesOf(db, await findEntryIdsByTitle(db, feedId, "CRÈME"))).toEqual([
      "Crème brûlée",
    ]);
  });

  it("treats SQL wildcards in the search as plain characters", async () => {
    const db = await openMigrated();
    const feedId = await seedTitles(db, ["100% done", "1000 things", "snake_case", "snakecase"]);
    expect(await titlesOf(db, await findEntryIdsByTitle(db, feedId, "%"))).toEqual(["100% done"]);
    expect(await titlesOf(db, await findEntryIdsByTitle(db, feedId, "_"))).toEqual(["snake_case"]);
  });

  it("only searches the given feed", async () => {
    const db = await openMigrated();
    const tech = await insertFeed(db, "tech");
    const food = await insertFeed(db, "food");
    await insertEntry(db, tech, "t", "2026-01-01T00:00:00.000Z", "Rust");
    await insertEntry(db, food, "f", "2026-01-01T00:00:00.000Z", "Rust stains");
    expect(await titlesOf(db, await findEntryIdsByTitle(db, tech, "rust"))).toEqual(["Rust"]);
  });
});

describe("findFeedPage with a search", () => {
  /** `count` entries titled "Rust 1".."Rust N", interleaved with as many "Go" ones. */
  const seedMixed = async (db: Database, count: number): Promise<void> => {
    const feedId = await insertFeed(db, "tech");
    for (let index = 1; index <= count; index += 1) {
      const minute = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      await insertEntry(db, feedId, `r-${String(index)}`, minute, `Rust ${String(index)}`);
      await insertEntry(db, feedId, `g-${String(index)}`, minute, `Go ${String(index)}`);
    }
  };

  it("pages through the matches only, and counts them", async () => {
    const db = await openMigrated();
    await seedMixed(db, 5);
    const loaded = await findFeedPage(db, "tech", 2, 2, "RUST");
    expect(loaded?.entries.map((entry) => entry.title)).toEqual(["Rust 3", "Rust 2"]);
    expect(loaded).toMatchObject({ page: 2, pageCount: 3, totalEntries: 5, query: "RUST" });
  });

  it("clamps a page past the end of the matches", async () => {
    const db = await openMigrated();
    await seedMixed(db, 5);
    const loaded = await findFeedPage(db, "tech", 9, 2, "rust");
    expect(loaded?.page).toBe(3);
    expect(loaded?.entries.map((entry) => entry.title)).toEqual(["Rust 1"]);
  });

  it("gives one empty page when nothing matches", async () => {
    const db = await openMigrated();
    await seedMixed(db, 3);
    const loaded = await findFeedPage(db, "tech", 1, 2, "python");
    expect(loaded).toMatchObject({ entries: [], page: 1, pageCount: 1, totalEntries: 0 });
  });

  it("treats a blank search as no search", async () => {
    const db = await openMigrated();
    await seedMixed(db, 3);
    const loaded = await findFeedPage(db, "tech", 1, 50, "   ");
    expect(loaded).toMatchObject({ totalEntries: 6, query: "" });
  });

  it("trims the search before matching", async () => {
    const db = await openMigrated();
    await seedMixed(db, 3);
    expect(await findFeedPage(db, "tech", 1, 50, "  rust  ")).toMatchObject({
      totalEntries: 3,
      query: "rust",
    });
  });
});
