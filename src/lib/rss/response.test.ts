import express from "express";
import { describe, expect, it, vi } from "vitest";
import Request from "../rest/request.js";
import { RssChannel } from "./feed.js";
import { RSS_CONTENT_TYPE, rssRoute, sendRssFeed } from "./response.js";

interface ResponseStub {
  set(name: string, value: string): ResponseStub;
  send(body: string): ResponseStub;
  status(code: number): ResponseStub;
}

interface FakeResponse {
  readonly headers: Map<string, string>;
  readonly res: express.Response;
  body(): string | undefined;
  statusCode(): number | undefined;
}

function fakeResponse(): FakeResponse {
  const headers = new Map<string, string>();
  const state: { body?: string; status?: number } = {};
  const res: ResponseStub = {
    set(name: string, value: string) {
      headers.set(name, value);
      return res;
    },
    send(body: string) {
      state.body = body;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
  };
  return {
    headers,
    res: res as unknown as express.Response,
    body: () => state.body,
    statusCode: () => state.status,
  };
}

const CHANNEL: RssChannel = {
  title: "Spigot",
  link: "https://spigot.test/",
  description: "Aggregated feeds",
};

interface Dependencies {
  readonly name: string;
}

function fakeRequest(dependencies: Dependencies): Request<Dependencies> {
  return { deps: dependencies } as unknown as Request<Dependencies>;
}

describe("sendRssFeed", () => {
  it("sets the RSS content type", () => {
    const response = fakeResponse();
    sendRssFeed(response.res, CHANNEL);
    expect(response.headers.get("Content-Type")).toBe(RSS_CONTENT_TYPE);
  });

  it("sends the rendered feed", () => {
    const response = fakeResponse();
    sendRssFeed(response.res, CHANNEL);
    expect(response.body()).toContain('<rss version="2.0">');
    expect(response.body()).toContain("<title>Spigot</title>");
  });
});

describe("rssRoute", () => {
  it("builds a GET route at the given path", () => {
    const route = rssRoute<Dependencies>("/feed.xml", () => CHANNEL);
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/feed.xml");
  });

  it("renders a synchronous channel", async () => {
    const response = fakeResponse();
    const route = rssRoute<Dependencies>("/feed.xml", () => CHANNEL);
    route.handler(fakeRequest({ name: "sync" }), response.res);
    await vi.waitFor(() => expect(response.body()).toContain("<title>Spigot</title>"));
    expect(response.headers.get("Content-Type")).toBe(RSS_CONTENT_TYPE);
  });

  it("renders an asynchronous channel and passes the request through", async () => {
    const response = fakeResponse();
    const route = rssRoute<Dependencies>("/feed.xml", (req) =>
      Promise.resolve({ ...CHANNEL, title: req.deps.name })
    );
    route.handler(fakeRequest({ name: "async" }), response.res);
    await vi.waitFor(() => expect(response.body()).toContain("<title>async</title>"));
  });

  it("answers a failed render with a 500 instead of throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = fakeResponse();
    const route = rssRoute<Dependencies>("/feed.xml", () => {
      throw new Error("boom");
    });
    route.handler(fakeRequest({ name: "boom" }), response.res);
    await vi.waitFor(() => expect(response.statusCode()).toBe(500));
    expect(response.body()).toBe("Failed to render the RSS feed");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
