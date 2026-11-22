import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../lib/database.js";
import Dependencies from "../lib/dependencies.js";
import { fromExpressApp } from "../lib/rest/application.js";
import { registerController } from "../lib/rest/controller.js";
import { FEED_NOT_FOUND_MESSAGE, RSS_CONTENT_TYPE } from "../lib/rss/index.js";
import { DEFAULT_ENTRY_LIMIT, ENTRY_TITLE_MAX_LENGTH } from "../lib/feeds/index.js";
import FeedsController, { parsePage, parseQuery } from "./feeds.js";

interface Harness {
  readonly port: number;
  readonly db: Database;
}

interface HttpResponse {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

const servers: http.Server[] = [];
const databases: Database[] = [];

/** Boots the real controller on a real port against a real migrated database. */
const boot = async (): Promise<Harness> => {
  const db = await loadDatabase(":memory:");
  databases.push(db);
  const dependencies: Dependencies = { db };
  const app = fromExpressApp(express(), dependencies);
  // Both entry forms post urlencoded, exactly as main.ts wires it.
  app.use(express.urlencoded({ extended: false }));
  registerController(app, FeedsController);
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to be listening on a TCP port");
  }
  return { port: address.port, db };
};

const call = (
  port: number,
  method: string,
  path: string,
  headers: http.OutgoingHttpHeaders = {}
): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: string[] = [];
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers["content-type"],
          headers: res.headers,
          body: chunks.join(""),
        })
      );
    });
    req.on("error", reject);
    req.end();
  });

const request = (port: number, path: string): Promise<HttpResponse> => call(port, "GET", path);

/** The plumbing both form helpers share: a request with a urlencoded body. */
const submitRaw = (
  port: number,
  method: string,
  path: string,
  payload: string
): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: string[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"],
            headers: res.headers,
            body: chunks.join(""),
          })
        );
      }
    );
    req.on("error", reject);
    req.end(payload);
  });

/**
 * Submits the entry form the way a browser does.
 *
 * Takes the body already encoded, because the tracking tests care about the
 * exact spelling of the URL they send.
 */
const postForm = (port: number, path: string, form: string): Promise<HttpResponse> =>
  submitRaw(port, "POST", path, form);

/** A form submission by field, in the encoding htmx sends one in. */
const submit = (
  port: number,
  method: string,
  path: string,
  fields: Record<string, string>
): Promise<HttpResponse> => submitRaw(port, method, path, new URLSearchParams(fields).toString());

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(databases.splice(0).map((db) => db.instance.close()));
});

const seed = async (db: Database, slug: string): Promise<void> => {
  const feed = await db.instance.run(
    "INSERT INTO feeds (slug, title, description, link) VALUES (?, ?, ?, ?)",
    [slug, "Tech Weekly", "Weekly technology roundup", "https://example.test/"]
  );
  await db.instance.run(
    `INSERT INTO entries (feed_id, guid, guid_is_permalink, url, title, description, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      feed.lastID,
      "entry-1",
      1,
      "https://example.test/1",
      "Shipping & Scaling",
      "<p>Notes</p>",
      "2026-01-15T08:30:05.000Z",
    ]
  );
};

describe("FeedsController", () => {
  it("serves a feed at the .xml URL readers expect", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const response = await request(port, "/feeds/tech.xml");
    expect(response.status).toBe(200);
    expect(response.contentType).toBe(RSS_CONTENT_TYPE);
    expect(response.body).toContain("<title>Tech Weekly</title>");
    expect(response.body).toContain("<title>Shipping &amp; Scaling</title>");
    expect(response.body).toContain("<pubDate>Thu, 15 Jan 2026 08:30:05 GMT</pubDate>");
  });

  it("serves the browsable page, not RSS, without the extension", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const response = await request(port, "/feeds/tech");
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/html");
    // The page, not the feed: a person gets HTML, a reader asks for .xml.
    expect(response.body).toContain("<!doctype html>");
    expect(response.body).not.toContain("<rss");
  });

  it("does not leak the .xml suffix into the slug", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    // Would 404 if `/:slug` were matched first and captured "tech.xml".
    expect((await request(port, "/feeds/tech.xml")).status).toBe(200);
  });

  it("points the self link at the URL the request arrived on", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const response = await request(port, "/feeds/tech.xml");
    expect(response.body).toContain(`href="http://127.0.0.1:${port}/feeds/tech.xml"`);
  });

  it("answers an unknown slug with a plain text 404, not an empty feed", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const response = await request(port, "/feeds/nope.xml");
    expect(response.status).toBe(404);
    expect(response.body).toBe(FEED_NOT_FOUND_MESSAGE);
    expect(response.contentType).toContain("text/plain");
    expect(response.body).not.toContain("<rss");
  });

  it("answers an unknown slug without the extension with a 404 too", async () => {
    const { port } = await boot();
    expect((await request(port, "/feeds/nope")).status).toBe(404);
  });

  it("serves a feed that has no entries", async () => {
    const { port, db } = await boot();
    await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", ["empty", "Empty"]);
    const response = await request(port, "/feeds/empty.xml");
    expect(response.status).toBe(200);
    expect(response.body).toContain("<title>Empty</title>");
    expect(response.body).not.toContain("<item>");
  });
});

describe("the feed page", () => {
  it("lists the feed's entries", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const response = await request(port, "/feeds/tech");
    expect(response.status).toBe(200);
    expect(response.body).toContain("Shipping &amp; Scaling");
    expect(response.body).toContain('href="https://example.test/1"');
    expect(response.body).toContain("/feeds/tech.xml");
  });

  it("renders an entry body as text rather than markup", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const response = await request(port, "/feeds/tech");
    // The seeded description is "<p>Notes</p>".
    expect(response.body).toContain("&lt;p&gt;Notes&lt;/p&gt;");
    expect(response.body).not.toContain("<p>Notes</p>");
  });

  it("answers an unknown slug with a 404 page", async () => {
    const { port } = await boot();
    const response = await request(port, "/feeds/nope");
    expect(response.status).toBe(404);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain("Not found");
  });

  it("shows an empty state for a feed with no entries", async () => {
    const { port, db } = await boot();
    await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", ["empty", "Empty"]);
    const response = await request(port, "/feeds/empty");
    expect(response.status).toBe(200);
    expect(response.body).toContain("No entries yet");
    expect(response.body).toContain("/api/feeds/empty/entries");
  });

  /*
   * The second line of defence. Validation stops this arriving through the API,
   * so the row is inserted directly — which is exactly how one could arrive in
   * production: a fixture, an import, a migration.
   */
  it("does not link an entry whose stored URL is a javascript: URL", async () => {
    const { port, db } = await boot();
    const feed = await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", [
      "tech",
      "Tech",
    ]);
    await db.instance.run("INSERT INTO entries (feed_id, guid, url, title) VALUES (?, ?, ?, ?)", [
      feed.lastID,
      "g",
      "javascript:alert(1)",
      "Dangerous",
    ]);
    const response = await request(port, "/feeds/tech");
    expect(response.status).toBe(200);
    expect(response.body).toContain("Dangerous");
    expect(response.body).not.toContain('href="javascript:');
    expect(response.body).not.toContain("javascript:alert(1)");
  });

  it("escapes a script payload in a feed title", async () => {
    const { port, db } = await boot();
    await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", [
      "x",
      "<script>alert(1)</script>",
    ]);
    const response = await request(port, "/feeds/x");
    expect(response.body).not.toContain("<script>alert(1)</script>");
    expect(response.body).toContain("&lt;script&gt;");
  });
});

describe("paging the feed page", () => {
  /**
   * A feed with `count` entries titled "Entry 1" (oldest) to "Entry N"
   * (newest), each a minute apart so the order is unambiguous.
   */
  const seedMany = async (db: Database, count: number): Promise<number> => {
    const feed = await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", [
      "tech",
      "Tech",
    ]);
    for (let index = 1; index <= count; index += 1) {
      const minute = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      await db.instance.run(
        "INSERT INTO entries (feed_id, guid, url, title, published_at) VALUES (?, ?, ?, ?, ?)",
        [
          feed.lastID,
          `g-${String(index)}`,
          `https://example.test/${String(index)}`,
          `Entry ${String(index)}`,
          minute,
        ]
      );
    }
    return feed.lastID as number;
  };

  /** Titles of the entries on a page, in the order they render. */
  const titles = (html: string): string[] =>
    [...html.matchAll(/>(Entry \d+)</g)].map((match) => match[1] ?? "");

  it("shows the newest page first and links the next", async () => {
    const { port, db } = await boot();
    await seedMany(db, DEFAULT_ENTRY_LIMIT * 2 + 20);
    const response = await request(port, "/feeds/tech");
    const shown = titles(response.body);
    expect(shown).toHaveLength(DEFAULT_ENTRY_LIMIT);
    expect(shown[0]).toBe(`Entry ${String(DEFAULT_ENTRY_LIMIT * 2 + 20)}`);
    expect(response.body).toContain('href="/feeds/tech?page=2" rel="next"');
    expect(response.body).toContain("Page 1 of 3");
  });

  it("counts every entry in the feed, not just the ones shown", async () => {
    const { port, db } = await boot();
    await seedMany(db, DEFAULT_ENTRY_LIMIT + 7);
    const response = await request(port, "/feeds/tech");
    expect(response.body).toContain(`${String(DEFAULT_ENTRY_LIMIT + 7)} entries`);
  });

  it("reaches the oldest entries on the last page", async () => {
    const { port, db } = await boot();
    await seedMany(db, DEFAULT_ENTRY_LIMIT * 2 + 20);
    const response = await request(port, "/feeds/tech?page=3");
    expect(titles(response.body)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Entry ${String(20 - index)}`)
    );
    expect(response.body).toContain('href="/feeds/tech?page=2" rel="prev"');
    expect(response.body).not.toContain('rel="next"');
  });

  it.each([["abc"], ["-1"], ["0"], ["1.5"]])(
    "treats a page of %s as the first page",
    async (page) => {
      const { port, db } = await boot();
      await seedMany(db, DEFAULT_ENTRY_LIMIT + 1);
      const response = await request(port, `/feeds/tech?page=${page}`);
      expect(response.status).toBe(200);
      expect(response.body).toContain("Page 1 of 2");
    }
  );

  it("shows the last page for a page past the end", async () => {
    const { port, db } = await boot();
    await seedMany(db, DEFAULT_ENTRY_LIMIT + 1);
    const response = await request(port, "/feeds/tech?page=9");
    expect(response.body).toContain("Page 2 of 2");
    expect(titles(response.body)).toEqual(["Entry 1"]);
  });

  it("keeps the reader on their page when they delete an entry there", async () => {
    const { port, db } = await boot();
    await seedMany(db, DEFAULT_ENTRY_LIMIT + 2);
    const row = await db.instance.get<{ id: number }>(
      "SELECT id FROM entries WHERE title = 'Entry 1'"
    );
    const response = await call(port, "DELETE", `/feeds/tech/entries/${String(row?.id)}`, {
      "HX-Current-URL": `http://127.0.0.1:${String(port)}/feeds/tech?page=2`,
    });
    expect(response.status).toBe(200);
    expect(titles(response.body)).toEqual(["Entry 2"]);
    expect(response.body).toContain(
      '<nav id="entry-pager" class="pager" aria-label="Entry pages" hx-swap-oob="outerHTML">'
    );
    expect(response.body).toContain(
      `<span id="entry-count" hx-swap-oob="outerHTML">${String(DEFAULT_ENTRY_LIMIT + 1)} entries</span>`
    );
  });

  it("drops the pager when a delete leaves one page", async () => {
    const { port, db } = await boot();
    await seedMany(db, DEFAULT_ENTRY_LIMIT + 1);
    const row = await db.instance.get<{ id: number }>(
      "SELECT id FROM entries WHERE title = 'Entry 1'"
    );
    const response = await call(port, "DELETE", `/feeds/tech/entries/${String(row?.id)}`, {
      "HX-Current-URL": `http://127.0.0.1:${String(port)}/feeds/tech?page=2`,
    });
    expect(titles(response.body)).toHaveLength(DEFAULT_ENTRY_LIMIT);
    expect(response.body).toContain(
      '<nav id="entry-pager" class="pager" aria-label="Entry pages" hx-swap-oob="outerHTML"></nav>'
    );
  });

  it("serves every entry in the RSS, not just one page's worth", async () => {
    const { port, db } = await boot();
    await seedMany(db, DEFAULT_ENTRY_LIMIT * 2 + 20);
    const response = await request(port, "/feeds/tech.xml");
    expect(response.body.match(/<item>/g)).toHaveLength(DEFAULT_ENTRY_LIMIT * 2 + 20);
    // Newest first, oldest last, the same order as the page.
    expect(response.body.indexOf("<title>Entry 120</title>")).toBeLessThan(
      response.body.indexOf("<title>Entry 1</title>")
    );
  });
});

describe("parsePage", () => {
  it.each([
    ["3", 3],
    ["1", 1],
    ["0", 1],
    ["-2", 1],
    ["two", 1],
    ["", 1],
    ["9999999999", 1],
  ])("reads %j as page %i", (value, expected) => {
    expect(parsePage(value)).toBe(expected);
  });

  it("treats a missing or repeated parameter as the first page", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage(["2", "3"])).toBe(1);
  });
});

describe("searching the feed page", () => {
  /** One feed holding the given titles, the first one newest. */
  const seedTitles = async (db: Database, titles: readonly string[]): Promise<void> => {
    const feed = await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", [
      "tech",
      "Tech",
    ]);
    for (const [index, title] of titles.entries()) {
      const minute = new Date(Date.UTC(2026, 0, 1, 0, titles.length - index)).toISOString();
      await db.instance.run(
        "INSERT INTO entries (feed_id, guid, url, title, published_at) VALUES (?, ?, ?, ?, ?)",
        [feed.lastID, `g-${String(index)}`, `https://example.test/${String(index)}`, title, minute]
      );
    }
  };

  /** Titles of the entries on a page, in the order they render. */
  const titles = (html: string): string[] =>
    [...html.matchAll(/<div class="entry-title"><a [^>]*>([^<]*)<\/a>/g)].map(
      (match) => match[1] ?? ""
    );

  it("shows only entries whose title matches, ignoring case", async () => {
    const { port, db } = await boot();
    await seedTitles(db, ["Rust in 2026", "Go notes", "Why RUST?"]);
    const response = await request(port, "/feeds/tech?q=rust");
    expect(response.status).toBe(200);
    expect(titles(response.body)).toEqual(["Rust in 2026", "Why RUST?"]);
    expect(response.body).toContain("2 matching entries");
    expect(response.body).toContain('value="rust"');
  });

  it("finds an ñ when the search has a plain n", async () => {
    const { port, db } = await boot();
    await seedTitles(db, ["Jalapeño poppers", "Plain"]);
    const response = await request(port, "/feeds/tech?q=jalapeno");
    expect(titles(response.body)).toEqual(["Jalapeño poppers"]);
  });

  it("matches accented titles regardless of case", async () => {
    const { port, db } = await boot();
    await seedTitles(db, ["Über alles", "Plain"]);
    const response = await request(port, `/feeds/tech?q=${encodeURIComponent("über")}`);
    expect(titles(response.body)).toEqual(["Über alles"]);
  });

  it("pages through the matches and keeps the search in the links", async () => {
    const { port, db } = await boot();
    // Twice a page and then some, alternating, so the matches alone run to two pages.
    await seedTitles(
      db,
      Array.from({ length: DEFAULT_ENTRY_LIMIT * 2 + 20 }, (_, index) =>
        index % 2 === 0 ? `Rust ${String(index)}` : `Go ${String(index)}`
      )
    );

    const first = await request(port, "/feeds/tech?q=rust");
    expect(titles(first.body)).toHaveLength(DEFAULT_ENTRY_LIMIT);
    expect(first.body).toContain("Page 1 of 2");
    expect(first.body).toContain('href="/feeds/tech?q=rust&amp;page=2" rel="next"');

    const second = await request(port, "/feeds/tech?q=rust&page=2");
    expect(titles(second.body)).toHaveLength(10);
    expect(second.body).toContain('href="/feeds/tech?q=rust" rel="prev"');
    expect(titles(second.body).every((title) => title.startsWith("Rust"))).toBe(true);
  });

  it("says when nothing matches", async () => {
    const { port, db } = await boot();
    await seedTitles(db, ["Go notes"]);
    const response = await request(port, "/feeds/tech?q=rust");
    expect(response.body).toContain("No entry titles match");
    expect(response.body).toContain("0 matching entries");
    expect(response.body).not.toContain("No entries yet");
  });

  it("shows everything for an empty search", async () => {
    const { port, db } = await boot();
    await seedTitles(db, ["Rust", "Go"]);
    const response = await request(port, "/feeds/tech?q=");
    expect(titles(response.body)).toEqual(["Rust", "Go"]);
    expect(response.body).toContain("2 entries");
  });

  it("does not filter the RSS", async () => {
    const { port, db } = await boot();
    await seedTitles(db, ["Rust", "Go"]);
    const response = await request(port, "/feeds/tech.xml?q=rust");
    expect(response.body.match(/<item>/g)).toHaveLength(2);
  });

  it("keeps the search when an entry is deleted", async () => {
    const { port, db } = await boot();
    await seedTitles(db, ["Rust one", "Go", "Rust two"]);
    const row = await db.instance.get<{ id: number }>(
      "SELECT id FROM entries WHERE title = 'Rust one'"
    );
    const response = await call(port, "DELETE", `/feeds/tech/entries/${String(row?.id)}`, {
      "HX-Current-URL": `http://127.0.0.1:${String(port)}/feeds/tech?q=rust`,
    });
    expect(response.status).toBe(200);
    expect(titles(response.body)).toEqual(["Rust two"]);
    expect(response.body).toContain(
      '<span id="entry-count" hx-swap-oob="outerHTML">1 matching entry</span>'
    );
  });
});

describe("parseQuery", () => {
  it("trims a search", () => {
    expect(parseQuery("  rust ")).toBe("rust");
  });

  it("treats a missing or repeated parameter as no search", () => {
    expect(parseQuery(undefined)).toBe("");
    expect(parseQuery(["a", "b"])).toBe("");
  });

  it("cuts a search to the longest title an entry can have", () => {
    expect(parseQuery("x".repeat(10_000))).toHaveLength(ENTRY_TITLE_MAX_LENGTH);
  });
});

describe("POST /feeds/:slug/entries", () => {
  const TRACKED =
    "url=https%3A%2F%2Fexample.test%2Fnew%3Futm_source%3Dnews%26page%3D2%23part-2&title=New";

  const storedUrl = async (db: Database): Promise<string | undefined> =>
    (await db.instance.get<{ url: string }>("SELECT url FROM entries ORDER BY id DESC LIMIT 1"))
      ?.url;

  /* Nothing on the form asks for this; the page does it for whatever is pasted. */
  it("removes the tracking parameters and keeps the rest of the url", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");

    const response = await postForm(port, "/feeds/tech/entries", TRACKED);

    expect(response.status).toBe(201);
    expect(await storedUrl(db)).toBe("https://example.test/new?page=2#part-2");
  });

  it("stores a url with no trackers exactly as it was pasted", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");

    const response = await postForm(
      port,
      "/feeds/tech/entries",
      "url=https%3A%2F%2Fexample.test%2Fnew%3Fq%3Da%2Bb%2520c&title=New"
    );

    expect(response.status).toBe(201);
    expect(await storedUrl(db)).toBe("https://example.test/new?q=a+b%20c");
  });

  it("returns the refreshed entry list on success", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");

    const response = await postForm(port, "/feeds/tech/entries", TRACKED);

    expect(response.body).toContain("New");
    expect(response.body).not.toContain("<!doctype html>");
  });
});

describe("the new entry form", () => {
  /* Nothing to opt into, so nothing to offer: the form takes a url and no more. */
  it("has no strip control to check", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");

    const body = (await request(port, "/feeds/tech")).body;

    expect(body).not.toContain('name="strip"');
  });

  /* Losing part of a pasted URL has to be legible before submitting, not after. */
  it("says what will be taken out of the URL", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");

    const body = (await request(port, "/feeds/tech")).body;

    expect(body).toContain("utm_source");
    expect(body).toContain("are removed from the URL");
  });
});

/** The id of the single entry `seed` inserts, which the delete routes address by. */
const seededEntryId = async (db: Database): Promise<number> => {
  const row = await db.instance.get<{ id: number }>("SELECT id FROM entries LIMIT 1");
  if (row === undefined) {
    throw new Error("Expected the seeded entry to exist");
  }
  return row.id;
};

describe("DELETE /feeds/:slug/entries/:entryId", () => {
  it("returns the refreshed entry list without the deleted entry", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    const response = await call(port, "DELETE", `/feeds/tech/entries/${String(entryId)}`);

    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/html");
    expect(response.body).not.toContain("Shipping &amp; Scaling");
    // The list, not the whole page: this is swapped into #entry-list.
    expect(response.body).not.toContain("<!doctype html>");
  });

  it("falls back to the empty state when the last entry goes", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    const response = await call(port, "DELETE", `/feeds/tech/entries/${String(entryId)}`);

    expect(response.body).toContain("No entries yet");
    expect(response.body).toContain("/api/feeds/tech/entries");
  });

  it("clears the error box out of band after a success", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    const response = await call(port, "DELETE", `/feeds/tech/entries/${String(entryId)}`);

    expect(response.body).toContain('<div id="errors" role="alert" hx-swap-oob="outerHTML">');
  });

  it("really removes the entry, and leaves the feed standing", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    await call(port, "DELETE", `/feeds/tech/entries/${String(entryId)}`);

    expect(await db.instance.get("SELECT count(*) AS n FROM entries")).toMatchObject({ n: 0 });
    expect(await db.instance.get("SELECT count(*) AS n FROM feeds")).toMatchObject({ n: 1 });
    expect((await request(port, "/feeds/tech")).status).toBe(200);
  });

  it("answers 404 and retargets at the error box for an entry already gone", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);
    await call(port, "DELETE", `/feeds/tech/entries/${String(entryId)}`);

    const response = await call(port, "DELETE", `/feeds/tech/entries/${String(entryId)}`);

    expect(response.status).toBe(404);
    expect(response.headers["hx-retarget"]).toBe("#errors");
    expect(response.headers["hx-reswap"]).toBe("innerHTML");
    expect(response.body).toContain("no longer exists");
  });

  it("answers 404 for a feed that does not exist", async () => {
    const { port } = await boot();
    const response = await call(port, "DELETE", "/feeds/nope/entries/1");
    expect(response.status).toBe(404);
    expect(response.body).toContain("does not exist");
  });

  it("answers 404 for an id that is not a number, rather than 500", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    expect((await call(port, "DELETE", "/feeds/tech/entries/banana")).status).toBe(404);
  });

  /* Ids are unique table-wide, so the feed in the path has to constrain them. */
  it("will not delete an entry through another feed's URL", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", ["other", "Other"]);
    const entryId = await seededEntryId(db);

    const response = await call(port, "DELETE", `/feeds/other/entries/${String(entryId)}`);

    expect(response.status).toBe(404);
    expect(await db.instance.get("SELECT count(*) AS n FROM entries")).toMatchObject({ n: 1 });
  });

  it("renders the delete control on the feed page, confirmation and all", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);
    const body = (await request(port, "/feeds/tech")).body;

    expect(body).toContain(`hx-delete="/feeds/tech/entries/${String(entryId)}"`);
    expect(body).toContain('hx-target="#entry-list"');
    expect(body).toContain("hx-confirm=");
    expect(body).toContain("aria-label=");
  });
});

describe("GET /feeds/:slug/entries/:entryId/edit", () => {
  it("returns the edit form for that row, filled in", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    const response = await request(port, `/feeds/tech/entries/${String(entryId)}/edit`);

    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain(`hx-patch="/feeds/tech/entries/${String(entryId)}"`);
    expect(response.body).toContain('value="https://example.test/1"');
    expect(response.body).toContain('value="Shipping &amp; Scaling"');
    // The row, not the page: this is swapped into the <li> it came from.
    expect(response.body).not.toContain("<!doctype html>");
  });

  it("renders the pencil control on the feed page", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    const body = (await request(port, "/feeds/tech")).body;

    expect(body).toContain(`hx-get="/feeds/tech/entries/${String(entryId)}/edit"`);
    expect(body).toContain('hx-target="closest li"');
    expect(body).toContain("aria-label=");
  });

  it("answers 404 for an entry that does not exist", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const response = await request(port, "/feeds/tech/entries/999/edit");
    expect(response.status).toBe(404);
    expect(response.headers["hx-retarget"]).toBe("#errors");
    expect(response.body).toContain("no longer exists");
  });

  it("answers 404 for a feed that does not exist", async () => {
    const { port } = await boot();
    expect((await request(port, "/feeds/nope/entries/1/edit")).status).toBe(404);
  });

  it("will not open another feed's entry for editing", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", ["other", "Other"]);
    const entryId = await seededEntryId(db);

    const response = await request(port, `/feeds/other/entries/${String(entryId)}/edit`);

    expect(response.status).toBe(404);
    expect(response.body).not.toContain("Shipping");
  });
});

describe("GET /feeds/:slug/entries/:entryId", () => {
  it("returns the row on its own, which is how Cancel restores it", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    const response = await request(port, `/feeds/tech/entries/${String(entryId)}`);

    expect(response.status).toBe(200);
    expect(response.body).toContain("Shipping &amp; Scaling");
    expect(response.body).toContain(`hx-delete="/feeds/tech/entries/${String(entryId)}"`);
    expect(response.body).not.toContain("hx-patch");
    expect(response.body).not.toContain("<!doctype html>");
  });

  it("changes nothing", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    await request(port, `/feeds/tech/entries/${String(entryId)}`);

    expect(await db.instance.get("SELECT title FROM entries")).toMatchObject({
      title: "Shipping & Scaling",
    });
  });

  it("answers 404 for an entry that is gone", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    expect((await request(port, "/feeds/tech/entries/999")).status).toBe(404);
  });
});

describe("PATCH /feeds/:slug/entries/:entryId", () => {
  it("returns the refreshed row and stores the change", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    const response = await submit(port, "PATCH", `/feeds/tech/entries/${String(entryId)}`, {
      url: "https://example.test/moved",
      title: "Renamed",
      publishedAt: "",
      description: "New notes",
    });

    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain("Renamed");
    expect(response.body).toContain('href="https://example.test/moved"');
    expect(await db.instance.get("SELECT title, url FROM entries")).toMatchObject({
      title: "Renamed",
      url: "https://example.test/moved",
    });
  });

  /* One row in, one row out: the rest of the list is not being edited. */
  it("returns only the edited row, not the whole list", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const feed = await db.instance.get<{ id: number }>("SELECT id FROM feeds");
    await db.instance.run("INSERT INTO entries (feed_id, guid, url, title) VALUES (?, ?, ?, ?)", [
      feed?.id,
      "entry-2",
      "https://example.test/2",
      "Another post",
    ]);
    const entryId = await seededEntryId(db);

    const response = await submit(port, "PATCH", `/feeds/tech/entries/${String(entryId)}`, {
      url: "https://example.test/1",
      title: "Renamed",
    });

    expect(response.body).toContain("Renamed");
    expect(response.body).not.toContain("Another post");
  });

  it("carries the guid along when the url of a permalink entry moves", async () => {
    const { port, db } = await boot();
    const feed = await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", [
      "tech",
      "Tech",
    ]);
    await db.instance.run(
      "INSERT INTO entries (feed_id, guid, guid_is_permalink, url, title) VALUES (?, ?, ?, ?, ?)",
      [feed.lastID, "https://example.test/1", 1, "https://example.test/1", "A post"]
    );
    const entryId = await seededEntryId(db);

    await submit(port, "PATCH", `/feeds/tech/entries/${String(entryId)}`, {
      url: "https://example.test/moved",
      title: "A post",
    });

    expect(await db.instance.get("SELECT guid FROM entries")).toMatchObject({
      guid: "https://example.test/moved",
    });
  });

  it("clears the error box out of band after a success", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    const response = await submit(port, "PATCH", `/feeds/tech/entries/${String(entryId)}`, {
      url: "https://example.test/1",
      title: "Renamed",
    });

    expect(response.body).toContain('hx-swap-oob="outerHTML"');
  });

  it("answers 400 and retargets at the error box for a rejected url", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const entryId = await seededEntryId(db);

    const response = await submit(port, "PATCH", `/feeds/tech/entries/${String(entryId)}`, {
      url: "javascript:alert(1)",
      title: "Renamed",
    });

    expect(response.status).toBe(400);
    expect(response.headers["hx-retarget"]).toBe("#errors");
    expect(response.headers["hx-reswap"]).toBe("innerHTML");
    expect(await db.instance.get("SELECT title FROM entries")).toMatchObject({
      title: "Shipping & Scaling",
    });
  });

  it("answers 409 when a renamed permalink collides with a sibling", async () => {
    const { port, db } = await boot();
    const feed = await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", [
      "tech",
      "Tech",
    ]);
    for (const n of [1, 2]) {
      await db.instance.run(
        "INSERT INTO entries (feed_id, guid, guid_is_permalink, url, title) VALUES (?, ?, ?, ?, ?)",
        [
          feed.lastID,
          `https://example.test/${String(n)}`,
          1,
          `https://example.test/${String(n)}`,
          `Post ${String(n)}`,
        ]
      );
    }
    const entryId = await seededEntryId(db);

    const response = await submit(port, "PATCH", `/feeds/tech/entries/${String(entryId)}`, {
      url: "https://example.test/2",
      title: "Post 1",
    });

    expect(response.status).toBe(409);
    expect(response.headers["hx-retarget"]).toBe("#errors");
    expect(response.body).toContain("already used in this feed");
  });

  it("answers 404 for an entry that is gone", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const response = await submit(port, "PATCH", "/feeds/tech/entries/999", {
      url: "https://example.test/1",
      title: "Renamed",
    });
    expect(response.status).toBe(404);
    expect(response.body).toContain("no longer exists");
  });

  it("answers 404 for a feed that does not exist", async () => {
    const { port } = await boot();
    const response = await submit(port, "PATCH", "/feeds/nope/entries/1", { title: "Renamed" });
    expect(response.status).toBe(404);
    expect(response.body).toContain("does not exist");
  });

  /* Ids are unique table-wide, so the feed in the path has to constrain them. */
  it("will not edit an entry through another feed's URL", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    await db.instance.run("INSERT INTO feeds (slug, title) VALUES (?, ?)", ["other", "Other"]);
    const entryId = await seededEntryId(db);

    const response = await submit(port, "PATCH", `/feeds/other/entries/${String(entryId)}`, {
      title: "Renamed",
    });

    expect(response.status).toBe(404);
    expect(await db.instance.get("SELECT title FROM entries")).toMatchObject({
      title: "Shipping & Scaling",
    });
  });

  it("answers 404 for an id that is not a number, rather than 500", async () => {
    const { port, db } = await boot();
    await seed(db, "tech");
    const response = await submit(port, "PATCH", "/feeds/tech/entries/banana", {
      title: "Renamed",
    });
    expect(response.status).toBe(404);
  });
});
