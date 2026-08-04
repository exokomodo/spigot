import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../lib/database.js";
import Dependencies from "../lib/dependencies.js";
import { fromExpressApp } from "../lib/rest/application.js";
import { registerController } from "../lib/rest/controller.js";
import { FEED_NOT_FOUND_MESSAGE, RSS_CONTENT_TYPE } from "../lib/rss/index.js";
import FeedsController from "./feeds.js";

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

const call = (port: number, method: string, path: string): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
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

    expect(response.body).toContain('hx-swap-oob="outerHTML"');
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
