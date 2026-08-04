import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../database.js";
import {
  EntryNotFoundError,
  FeedNotFoundError,
  createEntryFromRequest,
  deleteEntryFromRequest,
  parseEntryId,
  parseNewEntry,
} from "./entry-service.js";
import { FeedRow, createFeed, findEntriesByFeedId } from "./repository.js";
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
    parseNewEntry(feed, body, NOW);
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
    const entry = parseNewEntry(feed, valid, NOW);
    expect(entry.feedId).toBe(7);
    expect(entry.url).toBe("https://example.test/a");
    expect(entry.title).toBe("A post");
  });

  it("requires url and title", () => {
    expect(fields({})).toEqual(["url", "title"]);
  });

  it("trims surrounding whitespace", () => {
    const entry = parseNewEntry(feed, { url: "  https://example.test/a  ", title: "  A  " }, NOW);
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
      const entry = parseNewEntry(feed, valid, NOW);
      expect(entry.guid).toBe("https://example.test/a");
      expect(entry.guidIsPermalink).toBe(true);
    });

    it("is not a permalink when supplied explicitly", () => {
      const entry = parseNewEntry(feed, { ...valid, guid: "ep-42" }, NOW);
      expect(entry.guid).toBe("ep-42");
      expect(entry.guidIsPermalink).toBe(false);
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
      expect(parseNewEntry(feed, valid, NOW).publishedAt).toBe("2026-08-03T12:00:00.000Z");
    });

    it("defaults to now when blank", () => {
      expect(parseNewEntry(feed, { ...valid, publishedAt: "   " }, NOW).publishedAt).toBe(
        "2026-08-03T12:00:00.000Z"
      );
    });

    it("normalizes an accepted date to the format the schema stores", () => {
      const entry = parseNewEntry(feed, { ...valid, publishedAt: "2026-01-15" }, NOW);
      expect(entry.publishedAt).toBe("2026-01-15T00:00:00.000Z");
    });

    it("keeps an explicit instant", () => {
      const entry = parseNewEntry(feed, { ...valid, publishedAt: "2026-01-15T08:30:05Z" }, NOW);
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
      const entry = parseNewEntry(feed, { ...valid, ...enclosure }, NOW);
      expect(entry.enclosureUrl).toBe("https://example.test/a.mp3");
      expect(entry.enclosureLength).toBe(1234);
    });

    it("accepts a numeric length sent as a string, as a form would", () => {
      const entry = parseNewEntry(feed, { ...valid, ...enclosure, enclosureLength: "1234" }, NOW);
      expect(entry.enclosureLength).toBe(1234);
    });

    it("omits the enclosure entirely when no part is given", () => {
      const entry = parseNewEntry(feed, valid, NOW);
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
