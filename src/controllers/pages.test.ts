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
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<svg");
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
