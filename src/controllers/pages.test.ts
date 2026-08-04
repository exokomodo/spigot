import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import Database, { loadDatabase } from "../lib/database.js";
import Dependencies from "../lib/dependencies.js";
import { createFeedFromRequest } from "../lib/feeds/service.js";
import { fromExpressApp } from "../lib/rest/application.js";
import { registerController } from "../lib/rest/controller.js";
import PagesController from "./pages.js";

interface Harness {
  readonly port: number;
  readonly db: Database;
}

interface HttpResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

const servers: http.Server[] = [];
const databases: Database[] = [];

const boot = async (): Promise<Harness> => {
  const db = await loadDatabase(":memory:");
  databases.push(db);
  const dependencies: Dependencies = { db };
  const app = fromExpressApp(express(), dependencies);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerController(app, PagesController);
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

const request = (
  port: number,
  method: string,
  path: string,
  form?: string
): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers:
          form === undefined
            ? {}
            : {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(form),
              },
      },
      (res) => {
        const chunks: string[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: chunks.join("") })
        );
      }
    );
    req.on("error", reject);
    if (form !== undefined) {
      req.write(form);
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

const SCRIPT_PAYLOAD = "<script>alert(1)</script>";
const ATTRIBUTE_PAYLOAD = `" onerror="alert(1)`;

describe("GET /", () => {
  it("serves HTML", async () => {
    const { port } = await boot();
    const res = await request(port, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("invites the visitor to create one when there are no feeds", async () => {
    const { port } = await boot();
    expect((await request(port, "GET", "/")).body).toContain("No feeds yet");
  });

  it("lists a feed with its entry count and RSS link", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: "Tech Weekly" });
    const body = (await request(port, "GET", "/")).body;
    expect(body).toContain("Tech Weekly");
    expect(body).toContain("/feeds/tech-weekly.xml");
  });

  it("references the vendored htmx build rather than a CDN", async () => {
    const { port } = await boot();
    const body = (await request(port, "GET", "/")).body;
    expect(body).toContain("/vendor/htmx.min.js");
    expect(body).not.toMatch(/https?:\/\/[^"']*htmx/);
  });

  it("carries the icon links and the manifest in the head", async () => {
    const { port } = await boot();
    const body = (await request(port, "GET", "/")).body;
    expect(body).toContain('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"');
    expect(body).toContain('rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png"');
    expect(body).toContain('rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png"');
    expect(body).toContain('rel="manifest" href="/site.webmanifest"');
    // In <head>, where a browser reads them, not somewhere in the body.
    expect(body.indexOf("apple-touch-icon")).toBeLessThan(body.indexOf("</head>"));
  });
});

describe("XSS", () => {
  it("renders a script payload in a title as inert text on the page", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: SCRIPT_PAYLOAD });
    const body = (await request(port, "GET", "/")).body;

    expect(body).not.toContain(SCRIPT_PAYLOAD);
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders a script payload in a description as inert text", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: "Fine", description: SCRIPT_PAYLOAD });
    const body = (await request(port, "GET", "/")).body;

    expect(body).not.toContain(SCRIPT_PAYLOAD);
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes an attribute breakout payload", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: ATTRIBUTE_PAYLOAD });
    const body = (await request(port, "GET", "/")).body;

    expect(body).not.toContain(ATTRIBUTE_PAYLOAD);
    expect(body).toContain("&quot; onerror=&quot;alert(1)");
  });

  it("escapes a payload in the HTMX fragment too, not just the full page", async () => {
    const { port } = await boot();
    const res = await request(
      port,
      "POST",
      "/feeds",
      `title=${encodeURIComponent(SCRIPT_PAYLOAD)}`
    );

    expect(res.status).toBe(201);
    expect(res.body).not.toContain(SCRIPT_PAYLOAD);
    expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes an attribute payload in the fragment", async () => {
    const { port } = await boot();
    const res = await request(
      port,
      "POST",
      "/feeds",
      `title=${encodeURIComponent(ATTRIBUTE_PAYLOAD)}`
    );

    expect(res.body).not.toContain(ATTRIBUTE_PAYLOAD);
    expect(res.body).toContain("&quot; onerror=&quot;alert(1)");
  });

  it("cannot break out of the table cell it is rendered into", async () => {
    const { port, db } = await boot();
    const titlePayload = `</td></tr><img src=x onerror=alert(1)>`;
    const descriptionPayload = `</table><svg onload=alert(2)>`;
    await createFeedFromRequest(db, { title: titlePayload, description: descriptionPayload });
    const body = (await request(port, "GET", "/")).body;

    // The text `onerror=alert(1)` does survive, as inert characters inside an
    // escaped `&lt;img ...&gt;`. What must not survive is anything a parser
    // would read as a tag: no new element, and no closing of the real ones.
    // The page has an `<svg>` of its own — the trash icon — and an `<img>` —
    // the mark beside the heading — so the payload's opening tag is named
    // rather than the element.
    expect(body).not.toContain("<img src=x");
    expect(body).not.toContain("<svg onload");
    expect(body).not.toContain(titlePayload);
    expect(body).not.toContain(descriptionPayload);
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body).toContain("&lt;svg onload=alert(2)&gt;");
  });
});

describe("POST /feeds", () => {
  it("returns the refreshed table body on success", async () => {
    const { port } = await boot();
    const res = await request(port, "POST", "/feeds", "title=Tech+Weekly");
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain("Tech Weekly");
    expect(res.body).toContain("/feeds/tech-weekly.xml");
  });

  it("clears the error box out of band after a success", async () => {
    const { port } = await boot();
    const res = await request(port, "POST", "/feeds", "title=Tech");
    expect(res.body).toContain('hx-swap-oob="outerHTML"');
    expect(res.body).toContain('id="errors"');
  });

  it("answers 400 and retargets at the error box for an unusable title", async () => {
    const { port } = await boot();
    const res = await request(port, "POST", "/feeds", "title=%21%21%21");

    expect(res.status).toBe(400);
    expect(res.headers["hx-retarget"]).toBe("#errors");
    expect(res.headers["hx-reswap"]).toBe("innerHTML");
    expect(res.body).toContain("title");
    // The form never offered a slug, so no complaint may name one.
    expect(res.body).not.toContain("slug");
  });

  it("answers 400 when required fields are missing", async () => {
    const { port } = await boot();
    const res = await request(port, "POST", "/feeds", "");
    expect(res.status).toBe(400);
    expect(res.body).toContain("title");
  });

  it("answers 409 when another feed already derived the same slug", async () => {
    const { port } = await boot();
    await request(port, "POST", "/feeds", "title=Tech+Weekly");
    const res = await request(port, "POST", "/feeds", "title=TECH++weekly%21");

    expect(res.status).toBe(409);
    expect(res.headers["hx-retarget"]).toBe("#errors");
    expect(res.body).toContain("already taken");
    // The reader can only change the title, so that is what the error names.
    expect(res.body).toContain("/feeds/tech-weekly");
  });

  it("does not create a feed when the form is rejected", async () => {
    const { port, db } = await boot();
    await request(port, "POST", "/feeds", "title=%21%21%21");
    expect((await request(port, "GET", "/")).body).toContain("No feeds yet");
    expect(await db.instance.get("SELECT count(*) AS n FROM feeds")).toMatchObject({ n: 0 });
  });
});

describe("DELETE /feeds/:slug", () => {
  it("returns the refreshed table body without the deleted feed", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: "Tech Weekly" });
    await createFeedFromRequest(db, { title: "Food" });

    const res = await request(port, "DELETE", "/feeds/tech-weekly");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain("Food");
    expect(res.body).not.toContain("Tech Weekly");
  });

  it("returns the empty placeholder when the last feed goes", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: "Tech" });
    expect((await request(port, "DELETE", "/feeds/tech")).body).toContain("No feeds yet");
  });

  it("clears the error box out of band after a success", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: "Tech" });
    const res = await request(port, "DELETE", "/feeds/tech");
    expect(res.body).toContain('hx-swap-oob="outerHTML"');
    expect(res.body).toContain('id="errors"');
  });

  it("really removes the feed, not just its row in the fragment", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: "Tech" });

    await request(port, "DELETE", "/feeds/tech");

    expect(await db.instance.get("SELECT count(*) AS n FROM feeds")).toMatchObject({ n: 0 });
    expect((await request(port, "GET", "/")).body).toContain("No feeds yet");
  });

  it("takes the feed's entries with it", async () => {
    const { port, db } = await boot();
    const feed = await createFeedFromRequest(db, { title: "Tech" });
    await db.instance.run("INSERT INTO entries (feed_id, guid, url, title) VALUES (?, ?, ?, ?)", [
      feed.id,
      "g",
      "https://example.test/g",
      "A post",
    ]);

    await request(port, "DELETE", "/feeds/tech");

    expect(await db.instance.get("SELECT count(*) AS n FROM entries")).toMatchObject({ n: 0 });
  });

  /* A stale page, or a second click: a real 404 rather than a 500 or a fake 200. */
  it("answers 404 and retargets at the error box for a feed already gone", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: "Tech" });
    await request(port, "DELETE", "/feeds/tech");

    const res = await request(port, "DELETE", "/feeds/tech");

    expect(res.status).toBe(404);
    expect(res.headers["hx-retarget"]).toBe("#errors");
    expect(res.headers["hx-reswap"]).toBe("innerHTML");
    expect(res.body).toContain("no longer exists");
  });

  it("answers 404 for a slug that never existed", async () => {
    const { port } = await boot();
    expect((await request(port, "DELETE", "/feeds/nope")).status).toBe(404);
  });

  it("renders the delete control on the index, confirmation and all", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: "Tech Weekly" });
    const body = (await request(port, "GET", "/")).body;

    expect(body).toContain('hx-delete="/feeds/tech-weekly"');
    expect(body).toContain("hx-confirm=");
    expect(body).toContain("aria-label=");
  });

  it("escapes a title in the confirmation the fragment carries", async () => {
    const { port, db } = await boot();
    await createFeedFromRequest(db, { title: "Keep" });
    await createFeedFromRequest(db, { title: ATTRIBUTE_PAYLOAD });

    const res = await request(port, "DELETE", "/feeds/keep");

    expect(res.body).not.toContain(ATTRIBUTE_PAYLOAD);
    expect(res.body).toContain("&quot; onerror=&quot;alert(1)");
  });
});
