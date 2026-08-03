import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../database.js";
import { DuplicateSlugError } from "./repository.js";
import {
  SLUG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  ValidationError,
  createFeedFromRequest,
  listFeeds,
  parseNewFeed,
} from "./service.js";

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
  it("accepts a minimal valid body", () => {
    expect(parseNewFeed({ slug: "tech", title: "Tech" })).toMatchObject({
      slug: "tech",
      title: "Tech",
      description: "",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseNewFeed({ slug: "  tech  ", title: "  Tech  " })).toMatchObject({
      slug: "tech",
      title: "Tech",
    });
  });

  it("requires a slug", () => {
    expect(fieldsRejectedFor({ title: "Tech" })).toContain("slug");
    expect(fieldsRejectedFor({ slug: "   ", title: "Tech" })).toContain("slug");
  });

  it("requires a title", () => {
    expect(fieldsRejectedFor({ slug: "tech" })).toContain("title");
    expect(fieldsRejectedFor({ slug: "tech", title: "  " })).toContain("title");
  });

  it("reports every invalid field at once rather than the first", () => {
    expect(fieldsRejectedFor({})).toEqual(["slug", "title"]);
  });

  it("accepts lowercase alphanumerics in hyphen separated groups", () => {
    for (const slug of ["tech", "tech-weekly", "a1", "a-1-b"]) {
      expect(parseNewFeed({ slug, title: "T" }).slug).toBe(slug);
    }
  });

  it.each([
    ["Tech", "uppercase"],
    ["tech weekly", "a space"],
    ["tech_weekly", "an underscore"],
    ["-tech", "a leading hyphen"],
    ["tech-", "a trailing hyphen"],
    ["tech--weekly", "a doubled hyphen"],
    ["tech/../etc", "path traversal"],
    ["tech.xml", "a dot"],
    ["té", "a non-ascii letter"],
    ["%2e%2e", "percent encoding"],
  ])("rejects %j, which contains %s", (slug) => {
    expect(fieldsRejectedFor({ slug, title: "T" })).toContain("slug");
  });

  it("rejects an over-long slug", () => {
    expect(fieldsRejectedFor({ slug: "a".repeat(SLUG_MAX_LENGTH + 1), title: "T" })).toContain(
      "slug"
    );
  });

  it("rejects an over-long title", () => {
    expect(fieldsRejectedFor({ slug: "ok", title: "a".repeat(TITLE_MAX_LENGTH + 1) })).toContain(
      "title"
    );
  });

  it("ignores non-string values instead of coercing them", () => {
    expect(fieldsRejectedFor({ slug: 42, title: { a: 1 } })).toEqual(["slug", "title"]);
  });

  it("survives a body that is not an object at all", () => {
    expect(fieldsRejectedFor(null)).toEqual(["slug", "title"]);
    expect(fieldsRejectedFor("nope")).toEqual(["slug", "title"]);
    expect(fieldsRejectedFor(undefined)).toEqual(["slug", "title"]);
  });

  it("keeps a markup payload verbatim, since escaping belongs at render time", () => {
    // Sanitizing here would corrupt the stored title and still leave every
    // other render path unsafe; the escaping is the renderer's job.
    expect(parseNewFeed({ slug: "x", title: "<script>alert(1)</script>" }).title).toBe(
      "<script>alert(1)</script>"
    );
  });

  it("omits blank optional fields rather than storing empty strings", () => {
    const feed = parseNewFeed({ slug: "x", title: "T", link: "   ", language: "" });
    expect(feed.link).toBeUndefined();
    expect(feed.language).toBeUndefined();
  });
});

describe("createFeedFromRequest", () => {
  it("stores a feed and returns the row", async () => {
    const db = await open();
    const created = await createFeedFromRequest(db, { slug: "tech", title: "Tech Weekly" });
    expect(created).toMatchObject({ slug: "tech", title: "Tech Weekly", description: "" });
    expect(created.id).toBeGreaterThan(0);
  });

  it("rejects a duplicate slug with DuplicateSlugError", async () => {
    const db = await open();
    await createFeedFromRequest(db, { slug: "tech", title: "First" });
    await expect(createFeedFromRequest(db, { slug: "tech", title: "Second" })).rejects.toThrow(
      DuplicateSlugError
    );
  });

  it("does not store anything when validation fails", async () => {
    const db = await open();
    await expect(createFeedFromRequest(db, { slug: "Bad Slug", title: "T" })).rejects.toThrow(
      ValidationError
    );
    expect(await listFeeds(db)).toHaveLength(0);
  });

  it("treats a slug as data, not SQL", async () => {
    const db = await open();
    // Rejected by the pattern, but the point is the table is still there after.
    await expect(
      createFeedFromRequest(db, { slug: "x'); DROP TABLE feeds; --", title: "T" })
    ).rejects.toThrow(ValidationError);
    await createFeedFromRequest(db, { slug: "still-here", title: "T" });
    expect(await listFeeds(db)).toHaveLength(1);
  });
});

describe("listFeeds", () => {
  it("returns nothing when there are no feeds", async () => {
    expect(await listFeeds(await open())).toEqual([]);
  });

  it("counts entries per feed, including feeds with none", async () => {
    const db = await open();
    const tech = await createFeedFromRequest(db, { slug: "tech", title: "Tech" });
    await createFeedFromRequest(db, { slug: "empty", title: "Empty" });
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
    await createFeedFromRequest(db, { slug: "first", title: "First" });
    await createFeedFromRequest(db, { slug: "second", title: "Second" });
    expect((await listFeeds(db)).map((row) => row.slug)).toEqual(["second", "first"]);
  });

  it("counts entries for one feed without borrowing another's", async () => {
    const db = await open();
    const a = await createFeedFromRequest(db, { slug: "a", title: "A" });
    const b = await createFeedFromRequest(db, { slug: "b", title: "B" });
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
