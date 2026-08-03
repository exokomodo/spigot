import express from "express";
import Request, { DefaultDependenciesKey } from "../rest/request.js";
import { Route } from "../rest/controller.js";
import { RssChannel, renderFeed } from "./feed.js";

export const RSS_CONTENT_TYPE = "application/rss+xml; charset=utf-8";

/** Renders a channel and writes it to the response with the RSS content type. */
export function sendRssFeed(res: express.Response, channel: RssChannel): express.Response {
  return res.set("Content-Type", RSS_CONTENT_TYPE).send(renderFeed(channel));
}

/** Produces the channel served by an RSS route, synchronously or otherwise. */
export type RssChannelSource<TDependencies, TKey extends string = DefaultDependenciesKey> = (
  req: Request<TDependencies, TKey>
) => RssChannel | Promise<RssChannel>;

/**
 * Builds a `GET` route that renders `source` as an RSS feed. A rejected source
 * is logged and answered with a 500 rather than left as an unhandled rejection.
 */
export function rssRoute<TDependencies, TKey extends string = DefaultDependenciesKey>(
  path: string,
  source: RssChannelSource<TDependencies, TKey>
): Route<TDependencies, TKey> {
  return {
    path,
    method: "GET",
    handler: (req, res) => {
      void (async () => {
        try {
          sendRssFeed(res, await source(req));
        } catch (error) {
          console.error(`Failed to render the RSS feed for ${path}`, error);
          res.status(500).send("Failed to render the RSS feed");
        }
      })();
    },
  };
}
