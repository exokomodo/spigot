import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../../lib/database.js";
import Dependencies from "../../lib/dependencies.js";
import { fromExpressApp } from "../../lib/rest/application.js";
import { registerController } from "../../lib/rest/controller.js";
import ApiFeedsController from "./feeds.js";

interface Harness {
  readonly port: number;
  readonly db: Database;
}

interface JsonResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

const servers: http.Server[] = [];
const databases: Database[] = [];

const boot = async (): Promise<Harness> => {
  const db = await loadDatabase(":memory:");
  databases.push(db);
  const dependencies: Dependencies = { db };
  const app = fromExpressApp(express(), dependencies);
  app.use(express.json());
  registerController(app, ApiFeedsController);
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
  payload?: unknown
): Promise<JsonResponse> =>
  new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers:
          body === undefined
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: string[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => chunks.push(chunk));
        res.on("end", () => {
          const text = chunks.join("");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });

afterEach(async () => {
  while (servers.length > 0) {
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
  }
  while (databases.length > 0) {
    await databases.pop()?.instance.close();
  }
});

describe("GET /api/feeds", () => {
  it("returns an empty list before anything exists", async () => {
    const { port } = await boot();
    const res = await call(port, "GET", "/api/feeds");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ feeds: [] });
  });

  it("returns feeds with an entry count and feed url", async () => {
    const { port } = await boot();
    await call(port, "POST", "/api/feeds", { slug: "tech", title: "Tech Weekly" });

    const res = await call(port, "GET", "/api/feeds");
    expect(res.body.feeds).toMatchObject([
      { slug: "tech", title: "Tech Weekly", entryCount: 0, feedUrl: "/feeds/tech.xml" },
    ]);
  });

  it("omits keys for columns that are null rather than emitting null", async () => {
    const { port } = await boot();
    await call(port, "POST", "/api/feeds", { slug: "tech", title: "Tech" });
    const [feed] = (await call(port, "GET", "/api/feeds")).body.feeds as Record<string, unknown>[];
    expect(feed).not.toHaveProperty("link");
    expect(feed).not.toHaveProperty("language");
  });
});

describe("POST /api/feeds", () => {
  it("creates a feed and answers 201 with a Location header", async () => {
    const { port } = await boot();
    const res = await call(port, "POST", "/api/feeds", { slug: "tech", title: "Tech Weekly" });

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe("/api/feeds/tech");
    expect(res.body.feed).toMatchObject({ slug: "tech", title: "Tech Weekly", entryCount: 0 });
  });

  it("stores the optional fields it was given", async () => {
    const { port } = await boot();
    const res = await call(port, "POST", "/api/feeds", {
      slug: "tech",
      title: "Tech",
      description: "Weekly roundup",
      link: "https://tech.example/",
      language: "en-us",
    });
    expect(res.body.feed).toMatchObject({
      description: "Weekly roundup",
      link: "https://tech.example/",
      language: "en-us",
    });
  });

  it("answers 400 with per-field details for an invalid slug", async () => {
    const { port } = await boot();
    const res = await call(port, "POST", "/api/feeds", { slug: "Not A Slug", title: "T" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "invalid_request" });
    const details = (res.body.error as { details: { field: string }[] }).details;
    expect(details.map((d) => d.field)).toContain("slug");
  });

  it("answers 400 when the body is missing entirely", async () => {
    const { port } = await boot();
    const res = await call(port, "POST", "/api/feeds");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "invalid_request" });
  });

  it("answers 409 for a duplicate slug", async () => {
    const { port } = await boot();
    await call(port, "POST", "/api/feeds", { slug: "tech", title: "First" });
    const res = await call(port, "POST", "/api/feeds", { slug: "tech", title: "Second" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "slug_taken" });
  });

  it("keeps the original feed after a rejected duplicate", async () => {
    const { port } = await boot();
    await call(port, "POST", "/api/feeds", { slug: "tech", title: "First" });
    await call(port, "POST", "/api/feeds", { slug: "tech", title: "Second" });

    const feeds = (await call(port, "GET", "/api/feeds")).body.feeds as { title: string }[];
    expect(feeds).toHaveLength(1);
    expect(feeds[0].title).toBe("First");
  });

  it("returns markup in a title as data, not as escaped html", async () => {
    // The JSON API is not an HTML context; escaping here would corrupt the
    // value for every non-browser consumer. JSON string encoding is the only
    // escaping this response needs.
    const { port } = await boot();
    const res = await call(port, "POST", "/api/feeds", {
      slug: "evil",
      title: "<script>alert(1)</script>",
    });
    expect(res.body.feed).toMatchObject({ title: "<script>alert(1)</script>" });
  });
});
