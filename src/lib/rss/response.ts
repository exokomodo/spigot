import express from "express";
import Request, { DefaultDependenciesKey } from "../rest/request.js";
import { Route } from "../rest/controller.js";
import { RssChannel, renderFeed } from "./feed.js";

export const RSS_CONTENT_TYPE = "application/rss+xml; charset=utf-8";

export const PLAIN_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/** Sent when a source resolves to `undefined`. */
export const FEED_NOT_FOUND_MESSAGE = "Feed not found";

/** Renders a channel and writes it to the response with the RSS content type. */
export function sendRssFeed(res: express.Response, channel: RssChannel): express.Response {
  return res.set("Content-Type", RSS_CONTENT_TYPE).send(renderFeed(channel));
}

/**
 * Produces the channel served by an RSS route, synchronously or otherwise.
 *
 * Resolving to `undefined` means "no such feed" and becomes a 404 — the shape a
 * lookup keyed on something from the URL naturally returns when it misses.
 */
export type RssChannelSource<TDependencies, TKey extends string = DefaultDependenciesKey> = (
  req: Request<TDependencies, TKey>
) => RssChannel | undefined | Promise<RssChannel | undefined>;

/**
 * Builds a `GET` route that renders `source` as an RSS feed. A source that
 * resolves to `undefined` answers 404; one that throws or rejects is logged and
 * answered with a 500 rather than left as an unhandled rejection.
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
          const channel = await source(req);
          if (channel === undefined) {
            res
              .status(404)
              .set("Content-Type", PLAIN_TEXT_CONTENT_TYPE)
              .send(FEED_NOT_FOUND_MESSAGE);
            return;
          }
          sendRssFeed(res, channel);
        } catch (error) {
          console.error(`Failed to render the RSS feed for ${path}`, error);
          res.status(500).send("Failed to render the RSS feed");
        }
      })();
    },
  };
}
