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

const request = (port: number, path: string): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      const chunks: string[] = [];
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers["content-type"],
          body: chunks.join(""),
        })
      );
    });
    req.on("error", reject);
  });

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
