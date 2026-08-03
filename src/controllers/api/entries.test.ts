import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../../lib/database.js";
import Dependencies from "../../lib/dependencies.js";
import { createFeed } from "../../lib/feeds/repository.js";
import { fromExpressApp } from "../../lib/rest/application.js";
import { registerController } from "../../lib/rest/controller.js";
import ApiEntriesController from "./entries.js";

interface Harness {
  readonly port: number;
  readonly db: Database;
}

const servers: http.Server[] = [];
const databases: Database[] = [];

async function boot(): Promise<Harness> {
  const db = await loadDatabase(":memory:");
  databases.push(db);
  const app = fromExpressApp(express(), { db } satisfies Dependencies);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerController(app, ApiEntriesController);
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to be listening on a TCP port");
  }
  return { port: address.port, db };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  await Promise.all(databases.splice(0).map((db) => db.instance.close()));
});

interface Result {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly json: Record<string, unknown>;
}

function post(port: number, path: string, body: unknown): Promise<Result> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const valid = { url: "https://example.test/a", title: "A post" };

describe("POST /api/feeds/:slug/entries", () => {
  it("creates an entry and answers 201 with a Location", async () => {
    const { port, db } = await boot();
    await createFeed(db, { slug: "tech", title: "Tech" });
    const res = await post(port, "/api/feeds/tech/entries", valid);
    expect(res.status).toBe(201);
    expect(res.headers.location).toMatch(/^\/api\/feeds\/tech\/entries\/\d+$/);
    expect(res.json.entry).toMatchObject({ url: "https://example.test/a", title: "A post" });
  });

  it("404s for a feed that does not exist", async () => {
    const { port } = await boot();
    const res = await post(port, "/api/feeds/nope/entries", valid);
    expect(res.status).toBe(404);
    expect(res.json.error).toMatchObject({ code: "feed_not_found" });
  });

  it("400s a missing url and title, naming both", async () => {
    const { port, db } = await boot();
    await createFeed(db, { slug: "tech", title: "Tech" });
    const res = await post(port, "/api/feeds/tech/entries", {});
    expect(res.status).toBe(400);
    const error = res.json.error as { details: { field: string }[] };
    expect(error.details.map((d) => d.field)).toEqual(["url", "title"]);
  });

  /* The vector this endpoint introduces: a stored javascript: URL is waiting XSS. */
  it("400s a javascript: URL rather than storing it", async () => {
    const { port, db } = await boot();
    await createFeed(db, { slug: "tech", title: "Tech" });
    const res = await post(port, "/api/feeds/tech/entries", {
      ...valid,
      url: "javascript:alert(1)",
    });
    expect(res.status).toBe(400);
    const error = res.json.error as { details: { field: string }[] };
    expect(error.details.map((d) => d.field)).toEqual(["url"]);
    const count = await db.instance.get<{ n: number }>("SELECT COUNT(*) AS n FROM entries");
    expect(count?.n).toBe(0);
  });

  /*
   * Without validation this is a CHECK violation from migration 0002, which
   * would surface as a 500 for what is plainly a caller mistake.
   */
  it("400s an unparseable publishedAt rather than 500ing on the constraint", async () => {
    const { port, db } = await boot();
    await createFeed(db, { slug: "tech", title: "Tech" });
    const res = await post(port, "/api/feeds/tech/entries", { ...valid, publishedAt: "nope" });
    expect(res.status).toBe(400);
    const error = res.json.error as { details: { field: string }[] };
    expect(error.details.map((d) => d.field)).toEqual(["publishedAt"]);
  });

  it("409s a duplicate guid within the feed", async () => {
    const { port, db } = await boot();
    await createFeed(db, { slug: "tech", title: "Tech" });
    await post(port, "/api/feeds/tech/entries", { ...valid, guid: "g1" });
    const res = await post(port, "/api/feeds/tech/entries", { ...valid, guid: "g1" });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatchObject({ code: "guid_taken" });
  });

  it("allows the same guid in a different feed", async () => {
    const { port, db } = await boot();
    await createFeed(db, { slug: "one", title: "One" });
    await createFeed(db, { slug: "two", title: "Two" });
    await post(port, "/api/feeds/one/entries", { ...valid, guid: "shared" });
    const res = await post(port, "/api/feeds/two/entries", { ...valid, guid: "shared" });
    expect(res.status).toBe(201);
  });

  it("defaults publishedAt to now", async () => {
    const { port, db } = await boot();
    await createFeed(db, { slug: "tech", title: "Tech" });
    const res = await post(port, "/api/feeds/tech/entries", valid);
    const entry = res.json.entry as { publishedAt: string };
    expect(Number.isNaN(new Date(entry.publishedAt).getTime())).toBe(false);
  });
});
