import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../database.js";
import { DuplicateSlugError } from "./repository.js";
import {
  FeedNotFoundError,
  TITLE_MAX_LENGTH,
  ValidationError,
  createFeedFromRequest,
  deleteFeed,
  listFeeds,
  parseNewFeed,
} from "./service.js";
import { SLUG_MAX_LENGTH } from "./slug.js";

const databases: Database[] = [];

const open = async (): Promise<Database> => {
  const db = await loadDatabase(":memory:");
  databases.push(db);
  return db;
};

afterEach(async () => {
  while (databases.length > 0) {
    await databases.pop()?.instance.close();
  }
});

/** Collects the field names a body was rejected for. */
const fieldsRejectedFor = (body: unknown): readonly string[] => {
  try {
    parseNewFeed(body);
  } catch (error) {
    if (error instanceof ValidationError) {
      return error.issues.map((issue) => issue.field);
    }
    throw error;
  }
  return [];
};

describe("parseNewFeed", () => {
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " \tjavascript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "/relative/path",
  ])("rejects %j as a feed link", (link) => {
    expect(() => parseNewFeed({ title: "Tech", link })).toThrow(ValidationError);
  });

  it("accepts an http and an https link", () => {
    expect(parseNewFeed({ title: "Tech", link: "https://tech.example/" })).toMatchObject({
      link: "https://tech.example/",
    });
    expect(parseNewFeed({ title: "Tech", link: "http://tech.example/" })).toMatchObject({
      link: "http://tech.example/",
    });
  });

  it("accepts a minimal valid body", () => {
    expect(parseNewFeed({ title: "Tech" })).toMatchObject({
      slug: "tech",
      title: "Tech",
      description: "",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseNewFeed({ title: "  Tech  " })).toMatchObject({ slug: "tech", title: "Tech" });
  });

  it("derives the slug from the title", () => {
    expect(parseNewFeed({ title: "Tech Weekly" }).slug).toBe("tech-weekly");
    expect(parseNewFeed({ title: "Tech Weekly — 2024!" }).slug).toBe("tech-weekly-2024");
  });

  it("ignores a slug in the body, since the title is the only name a feed has", () => {
    expect(parseNewFeed({ slug: "something-else", title: "Tech Weekly" }).slug).toBe("tech-weekly");
    // Even a slug that would have been valid on its own does not get through.
    expect(parseNewFeed({ slug: "tech", title: "Tech Weekly" }).slug).toBe("tech-weekly");
  });

  it("requires a title", () => {
    expect(fieldsRejectedFor({})).toContain("title");
    expect(fieldsRejectedFor({ title: "  " })).toContain("title");
  });

  it.each(["!!!", "---", "🎧", "   ?   "])(
    "rejects %j, a title no slug can be built from",
    (title) => {
      expect(fieldsRejectedFor({ title })).toEqual(["title"]);
    }
  );

  it("says nothing about the slug, a field the caller was never asked for", () => {
    expect(fieldsRejectedFor({ title: "!!!" })).not.toContain("slug");
  });

  it("rejects an over-long title", () => {
    expect(fieldsRejectedFor({ title: "a".repeat(TITLE_MAX_LENGTH + 1) })).toContain("title");
  });

  it("caps a derived slug at the column's length", () => {
    const feed = parseNewFeed({ title: "word ".repeat(40) });
    expect(feed.slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });

  it("ignores non-string values instead of coercing them", () => {
    expect(fieldsRejectedFor({ title: { a: 1 } })).toEqual(["title"]);
  });

  it("survives a body that is not an object at all", () => {
    expect(fieldsRejectedFor(null)).toEqual(["title"]);
    expect(fieldsRejectedFor("nope")).toEqual(["title"]);
    expect(fieldsRejectedFor(undefined)).toEqual(["title"]);
  });

  it("keeps a markup payload verbatim, since escaping belongs at render time", () => {
    // Sanitizing here would corrupt the stored title and still leave every
    // other render path unsafe; the escaping is the renderer's job.
    expect(parseNewFeed({ title: "<script>alert(1)</script>" }).title).toBe(
      "<script>alert(1)</script>"
    );
  });

  it("strips a markup payload out of the slug it derives from that title", () => {
    expect(parseNewFeed({ title: "<script>alert(1)</script>" }).slug).toBe("script-alert-1-script");
  });

  it("omits blank optional fields rather than storing empty strings", () => {
    const feed = parseNewFeed({ title: "T", link: "   ", language: "" });
    expect(feed.link).toBeUndefined();
    expect(feed.language).toBeUndefined();
  });
});

describe("createFeedFromRequest", () => {
  it("stores a feed and returns the row", async () => {
    const db = await open();
    const created = await createFeedFromRequest(db, { title: "Tech Weekly" });
    expect(created).toMatchObject({ slug: "tech-weekly", title: "Tech Weekly", description: "" });
    expect(created.id).toBeGreaterThan(0);
  });

  it("rejects a second feed whose title derives the same slug", async () => {
    const db = await open();
    await createFeedFromRequest(db, { title: "Tech Weekly" });
    // Different titles, one address: the collision has to surface rather than
    // silently hand the second feed a URL that already belongs to the first.
    await expect(createFeedFromRequest(db, { title: "TECH  weekly!" })).rejects.toThrow(
      DuplicateSlugError
    );
  });

  it("does not store anything when validation fails", async () => {
    const db = await open();
    await expect(createFeedFromRequest(db, { title: "  " })).rejects.toThrow(ValidationError);
    expect(await listFeeds(db)).toHaveLength(0);
  });

  it("treats a title as data, not SQL", async () => {
    const db = await open();
    await createFeedFromRequest(db, { title: "x'); DROP TABLE feeds; --" });
    await createFeedFromRequest(db, { title: "Still Here" });
    expect((await listFeeds(db)).map((row) => row.slug)).toEqual([
      "still-here",
      "x-drop-table-feeds",
    ]);
  });
});

describe("listFeeds", () => {
  it("returns nothing when there are no feeds", async () => {
    expect(await listFeeds(await open())).toEqual([]);
  });

  it("counts entries per feed, including feeds with none", async () => {
    const db = await open();
    const tech = await createFeedFromRequest(db, { title: "Tech" });
    await createFeedFromRequest(db, { title: "Empty" });
    for (const guid of ["a", "b", "c"]) {
      await db.instance.run("INSERT INTO entries (feed_id, guid, url, title) VALUES (?, ?, ?, ?)", [
        tech.id,
        guid,
        `https://example.com/${guid}`,
        guid,
      ]);
    }

    const summaries = await listFeeds(db);
    const byslug = new Map(summaries.map((row) => [row.slug, row.entry_count]));
    expect(byslug.get("tech")).toBe(3);
    expect(byslug.get("empty")).toBe(0);
  });

  it("puts the newest feed first", async () => {
    const db = await open();
    await createFeedFromRequest(db, { title: "First" });
    await createFeedFromRequest(db, { title: "Second" });
    expect((await listFeeds(db)).map((row) => row.slug)).toEqual(["second", "first"]);
  });

  it("counts entries for one feed without borrowing another's", async () => {
    const db = await open();
    const a = await createFeedFromRequest(db, { title: "A" });
    const b = await createFeedFromRequest(db, { title: "B" });
    await db.instance.run("INSERT INTO entries (feed_id, guid, url, title) VALUES (?, ?, ?, ?)", [
      a.id,
      "g",
      "https://example.com/g",
      "g",
    ]);
    await db.instance.run("INSERT INTO entries (feed_id, guid, url, title) VALUES (?, ?, ?, ?)", [
      b.id,
      "g",
      "https://example.com/g",
      "g",
    ]);
    const counts = new Map((await listFeeds(db)).map((row) => [row.slug, row.entry_count]));
    expect(counts.get("a")).toBe(1);
    expect(counts.get("b")).toBe(1);
  });
});

describe("deleteFeed", () => {
  it("removes the feed from the listing", async () => {
    const db = await open();
    await createFeedFromRequest(db, { title: "Tech" });
    await createFeedFromRequest(db, { title: "Food" });

    await deleteFeed(db, "tech");

    expect((await listFeeds(db)).map((row) => row.slug)).toEqual(["food"]);
  });

  it("raises FeedNotFoundError for a slug that names nothing", async () => {
    const db = await open();
    await expect(deleteFeed(db, "nope")).rejects.toBeInstanceOf(FeedNotFoundError);
  });

  /* A double click or a stale page must not report success for a second delete. */
  it("raises FeedNotFoundError the second time the same feed is deleted", async () => {
    const db = await open();
    await createFeedFromRequest(db, { title: "Tech" });
    await deleteFeed(db, "tech");
    await expect(deleteFeed(db, "tech")).rejects.toBeInstanceOf(FeedNotFoundError);
  });

  it("names the slug it could not find", async () => {
    const db = await open();
    await expect(deleteFeed(db, "nope")).rejects.toMatchObject({ slug: "nope" });
  });

  it("takes the feed's entries with it", async () => {
    const db = await open();
    const tech = await createFeedFromRequest(db, { title: "Tech" });
    await db.instance.run("INSERT INTO entries (feed_id, guid, url, title) VALUES (?, ?, ?, ?)", [
      tech.id,
      "g",
      "https://example.com/g",
      "g",
    ]);

    await deleteFeed(db, "tech");

    expect(await db.instance.get("SELECT count(*) AS n FROM entries")).toMatchObject({ n: 0 });
  });
});
