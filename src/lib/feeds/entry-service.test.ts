import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../database.js";
import {
  ENTRY_URL_MAX_LENGTH,
  EntryNotFoundError,
  FeedNotFoundError,
  createEntryFromRequest,
  deleteEntryFromRequest,
  findEntryFromRequest,
  parseEntryId,
  parseNewEntry,
  parseStripFlag,
  stripFlagFromBody,
  updateEntryFromRequest,
} from "./entry-service.js";
import {
  DuplicateGuidError,
  FeedRow,
  createFeed,
  findEntriesByFeedId,
  findEntryById,
} from "./repository.js";
import { ValidationError } from "./service.js";

const feed: FeedRow = {
  id: 7,
  slug: "tech",
  title: "Tech",
  description: "",
  link: null,
  feed_url: null,
  language: null,
  copyright: null,
  managing_editor: null,
  webmaster: null,
  category: null,
  generator: null,
  image_url: null,
  ttl_minutes: null,
  last_built_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const NOW = new Date("2026-08-03T12:00:00.000Z");

function issues(body: unknown): readonly { field: string; message: string }[] {
  try {
    parseNewEntry(feed, body, { now: NOW });
  } catch (error) {
    if (error instanceof ValidationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("expected a ValidationError");
}

function fields(body: unknown): readonly string[] {
  return issues(body).map((issue) => issue.field);
}

describe("parseNewEntry", () => {
  const valid = { url: "https://example.test/a", title: "A post" };

  it("accepts a minimal entry", () => {
    const entry = parseNewEntry(feed, valid, { now: NOW });
    expect(entry.feedId).toBe(7);
    expect(entry.url).toBe("https://example.test/a");
    expect(entry.title).toBe("A post");
  });

  it("requires url and title", () => {
    expect(fields({})).toEqual(["url", "title"]);
  });

  it("trims surrounding whitespace", () => {
    const entry = parseNewEntry(
      feed,
      { url: "  https://example.test/a  ", title: "  A  " },
      { now: NOW }
    );
    expect(entry.url).toBe("https://example.test/a");
    expect(entry.title).toBe("A");
  });

  describe("url scheme", () => {
    it("rejects a javascript: URL", () => {
      expect(fields({ ...valid, url: "javascript:alert(1)" })).toEqual(["url"]);
    });

    it("rejects data: and vbscript: URLs", () => {
      expect(fields({ ...valid, url: "data:text/html,<script>x</script>" })).toEqual(["url"]);
      expect(fields({ ...valid, url: "vbscript:msgbox(1)" })).toEqual(["url"]);
    });

    it("rejects a relative URL", () => {
      expect(fields({ ...valid, url: "/posts/1" })).toEqual(["url"]);
    });

    it("explains what it wants", () => {
      const [issue] = issues({ ...valid, url: "javascript:alert(1)" });
      expect(issue.message).toContain("https://");
    });
  });

  describe("guid", () => {
    it("defaults to the url and is then a permalink", () => {
      const entry = parseNewEntry(feed, valid, { now: NOW });
      expect(entry.guid).toBe("https://example.test/a");
      expect(entry.guidIsPermalink).toBe(true);
    });

    it("is not a permalink when supplied explicitly", () => {
      const entry = parseNewEntry(feed, { ...valid, guid: "ep-42" }, { now: NOW });
      expect(entry.guid).toBe("ep-42");
      expect(entry.guidIsPermalink).toBe(false);
    });

    /*
     * The ordering constraint. A permalink guid claims to be the entry's
     * address, so it has to be derived from the URL that was stored and not the
     * one that arrived — otherwise the same article submitted twice, once with
     * tracking and once without, is two entries.
     */
    it("derives from the stripped url, not the submitted one", () => {
      const entry = parseNewEntry(
        feed,
        { ...valid, url: "https://example.test/a?utm_source=x" },
        { now: NOW, stripQuery: true }
      );
      expect(entry.url).toBe("https://example.test/a");
      expect(entry.guid).toBe("https://example.test/a");
      expect(entry.guidIsPermalink).toBe(true);
    });

    it("leaves an explicit guid alone even when the url is stripped", () => {
      const entry = parseNewEntry(
        feed,
        { ...valid, url: "https://example.test/a?utm_source=x", guid: "ep-42?keep=this" },
        { now: NOW, stripQuery: true }
      );
      expect(entry.url).toBe("https://example.test/a");
      expect(entry.guid).toBe("ep-42?keep=this");
      expect(entry.guidIsPermalink).toBe(false);
    });
  });

  describe("stripQuery", () => {
    const tracked = { ...valid, url: "https://example.test/a?utm_source=news#part-2" };

    it("keeps the url as sent when the option is absent", () => {
      expect(parseNewEntry(feed, tracked, { now: NOW }).url).toBe(
        "https://example.test/a?utm_source=news#part-2"
      );
    });

    it("keeps the url as sent when the option is off", () => {
      expect(parseNewEntry(feed, tracked, { now: NOW, stripQuery: false }).url).toBe(
        "https://example.test/a?utm_source=news#part-2"
      );
    });

    it("drops the query and keeps the fragment when the option is on", () => {
      expect(parseNewEntry(feed, tracked, { now: NOW, stripQuery: true }).url).toBe(
        "https://example.test/a#part-2"
      );
    });

    it("leaves the enclosure url alone", () => {
      const entry = parseNewEntry(
        feed,
        {
          ...tracked,
          enclosureUrl: "https://cdn.example.test/a.mp3?token=abc",
          enclosureType: "audio/mpeg",
          enclosureLength: 1234,
        },
        { now: NOW, stripQuery: true }
      );
      expect(entry.url).toBe("https://example.test/a#part-2");
      // A signed media URL stops working without its query; only the entry url was asked for.
      expect(entry.enclosureUrl).toBe("https://cdn.example.test/a.mp3?token=abc");
    });

    /* Stripping is not a way past validation, and not a way to fail it either. */
    it("still rejects a url that is unsafe once stripped", () => {
      expect(fields({ ...valid, url: "javascript:alert(1)?x=1" })).toEqual(["url"]);
    });

    it("still rejects an empty url", () => {
      expect(fields({ ...valid, url: "   " })).toEqual(["url"]);
    });

    /* The query is often most of what pushed a shared link over the limit. */
    it("measures the length limit against the stripped url", () => {
      const url = `https://example.test/a?${"x".repeat(ENTRY_URL_MAX_LENGTH)}`;
      expect(fields({ ...valid, url })).toContain("url");
      expect(parseNewEntry(feed, { ...valid, url }, { now: NOW, stripQuery: true }).url).toBe(
        "https://example.test/a"
      );
    });
  });

  describe("publishedAt", () => {
    /*
     * This is the reason the field is validated here at all. Migration 0002
     * constrains the column, so an unparseable value would reach SQLite as a
     * CHECK violation — a 500 for what is plainly a caller mistake.
     */
    it("rejects an unparseable date rather than letting it reach the database", () => {
      expect(fields({ ...valid, publishedAt: "not-a-date" })).toEqual(["publishedAt"]);
    });

    it("defaults to now when omitted", () => {
      expect(parseNewEntry(feed, valid, { now: NOW }).publishedAt).toBe("2026-08-03T12:00:00.000Z");
    });

    it("defaults to now when blank", () => {
      expect(parseNewEntry(feed, { ...valid, publishedAt: "   " }, { now: NOW }).publishedAt).toBe(
        "2026-08-03T12:00:00.000Z"
      );
    });

    it("normalizes an accepted date to the format the schema stores", () => {
      const entry = parseNewEntry(feed, { ...valid, publishedAt: "2026-01-15" }, { now: NOW });
      expect(entry.publishedAt).toBe("2026-01-15T00:00:00.000Z");
    });

    it("keeps an explicit instant", () => {
      const entry = parseNewEntry(
        feed,
        { ...valid, publishedAt: "2026-01-15T08:30:05Z" },
        { now: NOW }
      );
      expect(entry.publishedAt).toBe("2026-01-15T08:30:05.000Z");
    });
  });

  describe("enclosure", () => {
    const enclosure = {
      enclosureUrl: "https://example.test/a.mp3",
      enclosureType: "audio/mpeg",
      enclosureLength: 1234,
    };

    it("accepts all three parts together", () => {
      const entry = parseNewEntry(feed, { ...valid, ...enclosure }, { now: NOW });
      expect(entry.enclosureUrl).toBe("https://example.test/a.mp3");
      expect(entry.enclosureLength).toBe(1234);
    });

    it("accepts a numeric length sent as a string, as a form would", () => {
      const entry = parseNewEntry(
        feed,
        { ...valid, ...enclosure, enclosureLength: "1234" },
        { now: NOW }
      );
      expect(entry.enclosureLength).toBe(1234);
    });

    it("omits the enclosure entirely when no part is given", () => {
      const entry = parseNewEntry(feed, valid, { now: NOW });
      expect(entry.enclosureUrl).toBeUndefined();
    });

    it("rejects a partial enclosure rather than storing half of one", () => {
      expect(fields({ ...valid, enclosureUrl: "https://example.test/a.mp3" })).toEqual([
        "enclosure",
      ]);
    });

    it("rejects an unsafe enclosure URL", () => {
      expect(fields({ ...valid, ...enclosure, enclosureUrl: "javascript:alert(1)" })).toEqual([
        "enclosureUrl",
      ]);
    });

    it("rejects a non-positive or fractional length", () => {
      expect(fields({ ...valid, ...enclosure, enclosureLength: 0 })).toEqual(["enclosureLength"]);
      expect(fields({ ...valid, ...enclosure, enclosureLength: 1.5 })).toEqual(["enclosureLength"]);
    });
  });

  it("reports every problem at once rather than the first", () => {
    expect(fields({ url: "javascript:alert(1)", publishedAt: "nope" })).toEqual([
      "url",
      "title",
      "publishedAt",
    ]);
  });

  it("tolerates a body that is not an object", () => {
    expect(fields(null)).toEqual(["url", "title"]);
    expect(fields("a string")).toEqual(["url", "title"]);
  });
});

describe("FeedNotFoundError", () => {
  it("carries the slug it could not find", () => {
    expect(new FeedNotFoundError("missing").slug).toBe("missing");
  });
});

describe("EntryNotFoundError", () => {
  it("carries the id it could not find, as it was written", () => {
    expect(new EntryNotFoundError("banana").entryId).toBe("banana");
  });
});

describe("parseEntryId", () => {
  it("reads a plain decimal id", () => {
    expect(parseEntryId("7")).toBe(7);
    expect(parseEntryId("1234")).toBe(1234);
  });

  /*
   * All of these convert to a number, and several convert to a real row id.
   * Accepting them would give every entry several spellings of its address and
   * let a request name a row it did not mean to.
   */
  it.each(["", " 7 ", "7e0", "0x7", "7.0", "+7", "-7", "0", "banana", "7; DROP TABLE entries"])(
    "refuses %j",
    (raw) => {
      expect(parseEntryId(raw)).toBeUndefined();
    }
  );

  it("refuses an id past the safe integer range", () => {
    expect(parseEntryId("9007199254740993")).toBeUndefined();
  });
});

describe("createEntryFromRequest", () => {
  const databases: Database[] = [];

  const open = async (): Promise<Database> => {
    const db = await loadDatabase(":memory:");
    databases.push(db);
    return db;
  };

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.instance.close()));
  });

  const tracked = { url: "https://example.test/a?utm_source=news", title: "A post" };

  it("stores the url as sent when no option is passed", async () => {
    const db = await open();
    await createFeed(db, { slug: "tech", title: "Tech" });
    const { entry } = await createEntryFromRequest(db, "tech", tracked);
    expect(entry.url).toBe("https://example.test/a?utm_source=news");
  });

  it("stores the stripped url when the option is on", async () => {
    const db = await open();
    await createFeed(db, { slug: "tech", title: "Tech" });
    const { entry } = await createEntryFromRequest(db, "tech", tracked, { stripQuery: true });
    expect(entry.url).toBe("https://example.test/a");
    expect(entry.guid).toBe("https://example.test/a");
  });

  /*
   * The practical payoff of stripping before the guid is derived: the same
   * article shared twice with different tracking is one entry, not two.
   */
  it("makes two differently tracked copies of one link collide", async () => {
    const db = await open();
    await createFeed(db, { slug: "tech", title: "Tech" });
    await createEntryFromRequest(db, "tech", tracked, { stripQuery: true });

    await expect(
      createEntryFromRequest(
        db,
        "tech",
        { ...tracked, url: "https://example.test/a?utm_source=twitter" },
        { stripQuery: true }
      )
    ).rejects.toBeInstanceOf(DuplicateGuidError);
  });
});

describe("parseStripFlag", () => {
  /* Absent is the one that matters: it is what every existing caller sends. */
  it("is off when absent", () => {
    expect(parseStripFlag(undefined)).toBe(false);
  });

  it.each(["true", "1", "on", "TRUE", "  On  "])("reads %j as on", (value) => {
    expect(parseStripFlag(value)).toBe(true);
  });

  /* `?strip` with no value: writing the flag at all is the request. */
  it("reads a bare flag as on", () => {
    expect(parseStripFlag("")).toBe(true);
  });

  it.each(["false", "0", "off", "OFF"])("reads %j as off", (value) => {
    expect(parseStripFlag(value)).toBe(false);
  });

  /*
   * The alternative would be reading a typo as false, which silently stores the
   * tracking parameters the caller asked to drop and answers 201 either way.
   */
  it.each(["yes", "maybe", "tru", "2", "null"])("rejects %j rather than guessing", (value) => {
    expect(() => parseStripFlag(value)).toThrow(ValidationError);
  });

  it("names the field and the accepted spellings when it rejects", () => {
    try {
      parseStripFlag("yes");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issue = (error as ValidationError).issues[0];
      expect(issue.field).toBe("strip");
      expect(issue.message).toContain("true");
      expect(issue.message).toContain("off");
      return;
    }
    throw new Error("expected a ValidationError");
  });

  /* A repeated query parameter arrives as an array and has no single answer. */
  it("rejects a value that is not a single string", () => {
    expect(() => parseStripFlag(["true", "false"])).toThrow(ValidationError);
    expect(() => parseStripFlag(true)).toThrow(ValidationError);
  });
});

describe("stripFlagFromBody", () => {
  it("is off for a body with no flag, including one that is not an object", () => {
    expect(stripFlagFromBody({ url: "https://example.test/a" })).toBe(false);
    expect(stripFlagFromBody(undefined)).toBe(false);
    expect(stripFlagFromBody("nonsense")).toBe(false);
  });

  /* What a checked checkbox posts, both with and without a value attribute. */
  it("reads what a checked checkbox posts", () => {
    expect(stripFlagFromBody({ strip: "true" })).toBe(true);
    expect(stripFlagFromBody({ strip: "on" })).toBe(true);
  });
});

describe("deleteEntryFromRequest", () => {
  const databases: Database[] = [];

  const open = async (): Promise<Database> => {
    const db = await loadDatabase(":memory:");
    databases.push(db);
    return db;
  };

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.instance.close()));
  });

  const valid = { url: "https://example.test/a", title: "A post" };

  it("removes the entry and returns the feed it left", async () => {
    const db = await open();
    await createFeed(db, { slug: "tech", title: "Tech" });
    const { entry } = await createEntryFromRequest(db, "tech", valid);

    const feed = await deleteEntryFromRequest(db, "tech", String(entry.id));

    expect(feed.slug).toBe("tech");
    expect(await findEntriesByFeedId(db, feed.id)).toEqual([]);
  });

  it("raises FeedNotFoundError when the slug names nothing", async () => {
    const db = await open();
    await expect(deleteEntryFromRequest(db, "nope", "1")).rejects.toBeInstanceOf(FeedNotFoundError);
  });

  it("raises EntryNotFoundError when the id names nothing in the feed", async () => {
    const db = await open();
    await createFeed(db, { slug: "tech", title: "Tech" });
    await expect(deleteEntryFromRequest(db, "tech", "999")).rejects.toBeInstanceOf(
      EntryNotFoundError
    );
  });

  it("raises EntryNotFoundError rather than querying on an id that is not one", async () => {
    const db = await open();
    await createFeed(db, { slug: "tech", title: "Tech" });
    await expect(deleteEntryFromRequest(db, "tech", "banana")).rejects.toBeInstanceOf(
      EntryNotFoundError
    );
  });

  /* The whole reason the feed is resolved before the delete rather than after. */
  it("will not delete an entry through another feed's slug", async () => {
    const db = await open();
    await createFeed(db, { slug: "one", title: "One" });
    const two = await createFeed(db, { slug: "two", title: "Two" });
    const { entry } = await createEntryFromRequest(db, "two", valid);

    await expect(deleteEntryFromRequest(db, "one", String(entry.id))).rejects.toBeInstanceOf(
      EntryNotFoundError
    );
    expect(await findEntriesByFeedId(db, two.id)).toHaveLength(1);
  });

  it("raises EntryNotFoundError the second time the same entry is deleted", async () => {
    const db = await open();
    await createFeed(db, { slug: "tech", title: "Tech" });
    const { entry } = await createEntryFromRequest(db, "tech", valid);
    await deleteEntryFromRequest(db, "tech", String(entry.id));

    await expect(deleteEntryFromRequest(db, "tech", String(entry.id))).rejects.toBeInstanceOf(
      EntryNotFoundError
    );
  });
});

describe("findEntryFromRequest", () => {
  const databases: Database[] = [];

  const open = async (): Promise<Database> => {
    const db = await loadDatabase(":memory:");
    databases.push(db);
    return db;
  };

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.instance.close()));
  });

  const valid = { url: "https://example.test/a", title: "A post" };

  it("returns the entry", async () => {
    const db = await open();
    await createFeed(db, { slug: "tech", title: "Tech" });
    const { entry } = await createEntryFromRequest(db, "tech", valid);

    expect(await findEntryFromRequest(db, "tech", String(entry.id))).toMatchObject({
      id: entry.id,
      title: "A post",
    });
  });

  it("raises FeedNotFoundError when the slug names nothing", async () => {
    const db = await open();
    await expect(findEntryFromRequest(db, "nope", "1")).rejects.toBeInstanceOf(FeedNotFoundError);
  });

  it("raises EntryNotFoundError rather than querying on an id that is not one", async () => {
    const db = await open();
    await createFeed(db, { slug: "tech", title: "Tech" });
    await expect(findEntryFromRequest(db, "tech", "banana")).rejects.toBeInstanceOf(
      EntryNotFoundError
    );
  });

  it("will not read an entry through another feed's slug", async () => {
    const db = await open();
    await createFeed(db, { slug: "one", title: "One" });
    await createFeed(db, { slug: "two", title: "Two" });
    const { entry } = await createEntryFromRequest(db, "two", valid);

    await expect(findEntryFromRequest(db, "one", String(entry.id))).rejects.toBeInstanceOf(
      EntryNotFoundError
    );
  });
});

describe("updateEntryFromRequest", () => {
  const databases: Database[] = [];

  const open = async (): Promise<Database> => {
    const db = await loadDatabase(":memory:");
    databases.push(db);
    return db;
  };

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.instance.close()));
  });

  const valid = { url: "https://example.test/a", title: "A post" };

  /** A feed holding one entry, returned with the id the tests address it by. */
  const seed = async (
    db: Database,
    body: Record<string, unknown> = valid
  ): Promise<{ readonly feedId: number; readonly entryId: string }> => {
    const feed = await createFeed(db, { slug: "tech", title: "Tech" });
    const { entry } = await createEntryFromRequest(db, "tech", body, { now: NOW });
    return { feedId: feed.id, entryId: String(entry.id) };
  };

  it("applies the fields the body carries", async () => {
    const db = await open();
    const { entryId } = await seed(db);

    const updated = await updateEntryFromRequest(db, "tech", entryId, { title: "Renamed" }, NOW);

    expect(updated.title).toBe("Renamed");
  });

  it("trims what it stores, the way creating one does", async () => {
    const db = await open();
    const { entryId } = await seed(db);

    const updated = await updateEntryFromRequest(
      db,
      "tech",
      entryId,
      { title: "  Renamed  " },
      NOW
    );

    expect(updated.title).toBe("Renamed");
  });

  /*
   * The reason this is a PATCH and not a PUT. The HTML form carries four
   * fields, and a replacement built from it would blank everything else on the
   * row — including columns the form has never heard of.
   */
  it("leaves fields the body does not mention alone", async () => {
    const db = await open();
    const { entryId } = await seed(db, {
      ...valid,
      author: "Ada",
      categories: "rust,web",
      enclosureUrl: "https://example.test/a.mp3",
      enclosureType: "audio/mpeg",
      enclosureLength: 1234,
    });

    const updated = await updateEntryFromRequest(db, "tech", entryId, { title: "Renamed" }, NOW);

    expect(updated).toMatchObject({
      title: "Renamed",
      author: "Ada",
      categories: "rust,web",
      enclosure_url: "https://example.test/a.mp3",
      enclosure_length: 1234,
      published_at: "2026-08-03T12:00:00.000Z",
    });
  });

  it("clears a field the body sends blank", async () => {
    const db = await open();
    const { entryId } = await seed(db, { ...valid, description: "Notes" });

    const updated = await updateEntryFromRequest(db, "tech", entryId, { description: "" }, NOW);

    expect(updated.description).toBeNull();
  });

  describe("the guid", () => {
    /* The subtle part: a permalink guid *is* the url, so it has to move with it. */
    it("follows the url when the entry's guid is its url", async () => {
      const db = await open();
      const { entryId } = await seed(db);

      const updated = await updateEntryFromRequest(
        db,
        "tech",
        entryId,
        { url: "https://example.test/moved" },
        NOW
      );

      expect(updated.guid).toBe("https://example.test/moved");
      expect(updated.guid_is_permalink).toBe(1);
    });

    it("stays put when the entry has a guid of its own", async () => {
      const db = await open();
      const { entryId } = await seed(db, { ...valid, guid: "ep-42" });

      const updated = await updateEntryFromRequest(
        db,
        "tech",
        entryId,
        { url: "https://example.test/moved" },
        NOW
      );

      expect(updated.url).toBe("https://example.test/moved");
      expect(updated.guid).toBe("ep-42");
      expect(updated.guid_is_permalink).toBe(0);
    });

    it("does not move when the url is not being changed", async () => {
      const db = await open();
      const { entryId } = await seed(db);

      const updated = await updateEntryFromRequest(db, "tech", entryId, { title: "Renamed" }, NOW);

      expect(updated.guid).toBe("https://example.test/a");
    });

    /* A permalink rename can collide with a sibling, and that is a 409. */
    it("raises DuplicateGuidError when the new url is another entry's guid", async () => {
      const db = await open();
      const { entryId } = await seed(db);
      await createEntryFromRequest(
        db,
        "tech",
        { ...valid, url: "https://example.test/b" },
        { now: NOW }
      );

      await expect(
        updateEntryFromRequest(db, "tech", entryId, { url: "https://example.test/b" }, NOW)
      ).rejects.toBeInstanceOf(DuplicateGuidError);
    });

    it("cannot be set directly, since it is the entry's identity to a reader", async () => {
      const db = await open();
      const { entryId } = await seed(db, { ...valid, guid: "ep-42" });

      const updated = await updateEntryFromRequest(db, "tech", entryId, { guid: "ep-43" }, NOW);

      expect(updated.guid).toBe("ep-42");
    });
  });

  describe("publishedAt", () => {
    it("accepts a new date and normalizes it", async () => {
      const db = await open();
      const { entryId } = await seed(db);

      const updated = await updateEntryFromRequest(
        db,
        "tech",
        entryId,
        { publishedAt: "2026-01-15" },
        NOW
      );

      expect(updated.published_at).toBe("2026-01-15T00:00:00.000Z");
    });

    /*
     * The edit form's date input is empty until someone picks a date, because a
     * `datetime-local` value has no timezone to prefill it with. A blank one
     * therefore means "unchanged" and not "now" or "never".
     */
    it("keeps the stored date when the body sends a blank one", async () => {
      const db = await open();
      const { entryId } = await seed(db);

      const updated = await updateEntryFromRequest(
        db,
        "tech",
        entryId,
        { title: "Renamed", publishedAt: "  " },
        NOW
      );

      expect(updated.published_at).toBe("2026-08-03T12:00:00.000Z");
    });

    it("rejects an unparseable date rather than letting it reach the database", async () => {
      const db = await open();
      const { entryId } = await seed(db);

      await expect(
        updateEntryFromRequest(db, "tech", entryId, { publishedAt: "not-a-date" }, NOW)
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("validation", () => {
    it("rejects a url that is not one a browser should follow", async () => {
      const db = await open();
      const { entryId } = await seed(db);

      await expect(
        updateEntryFromRequest(db, "tech", entryId, { url: "javascript:alert(1)" }, NOW)
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a title emptied to nothing", async () => {
      const db = await open();
      const { entryId } = await seed(db);

      await expect(
        updateEntryFromRequest(db, "tech", entryId, { title: "   " }, NOW)
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("stores nothing when the body is rejected", async () => {
      const db = await open();
      const { feedId, entryId } = await seed(db);

      await expect(
        updateEntryFromRequest(db, "tech", entryId, { title: "Renamed", url: "/relative" }, NOW)
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await findEntryById(db, feedId, Number(entryId))).toMatchObject({ title: "A post" });
    });

    it("names every problem at once", async () => {
      const db = await open();
      const { entryId } = await seed(db);

      await updateEntryFromRequest(db, "tech", entryId, { url: "nope", title: "" }, NOW).catch(
        (error: unknown) => {
          expect(error).toBeInstanceOf(ValidationError);
          expect((error as ValidationError).issues.map((issue) => issue.field)).toEqual([
            "url",
            "title",
          ]);
        }
      );
    });

    it("tolerates a body that is not an object, and changes nothing", async () => {
      const db = await open();
      const { entryId } = await seed(db);

      expect((await updateEntryFromRequest(db, "tech", entryId, null, NOW)).title).toBe("A post");
    });
  });

  it("raises FeedNotFoundError when the slug names nothing", async () => {
    const db = await open();
    await expect(
      updateEntryFromRequest(db, "nope", "1", { title: "x" }, NOW)
    ).rejects.toBeInstanceOf(FeedNotFoundError);
  });

  it("raises EntryNotFoundError when the id names nothing in the feed", async () => {
    const db = await open();
    await createFeed(db, { slug: "tech", title: "Tech" });
    await expect(
      updateEntryFromRequest(db, "tech", "999", { title: "x" }, NOW)
    ).rejects.toBeInstanceOf(EntryNotFoundError);
  });

  /* The reason the feed is resolved before the write rather than after. */
  it("will not edit an entry through another feed's slug", async () => {
    const db = await open();
    await createFeed(db, { slug: "one", title: "One" });
    const two = await createFeed(db, { slug: "two", title: "Two" });
    const { entry } = await createEntryFromRequest(db, "two", valid, { now: NOW });

    await expect(
      updateEntryFromRequest(db, "one", String(entry.id), { title: "Renamed" }, NOW)
    ).rejects.toBeInstanceOf(EntryNotFoundError);
    expect(await findEntryById(db, two.id, entry.id)).toMatchObject({ title: "A post" });
  });
});
