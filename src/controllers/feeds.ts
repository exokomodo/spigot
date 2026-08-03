import express from "express";
import Dependencies from "../lib/dependencies.js";
import {
  DuplicateGuidError,
  FeedNotFoundError,
  createEntryFromRequest,
} from "../lib/feeds/entry-service.js";
import { findFeedWithEntries, toRssFeed } from "../lib/feeds/index.js";
import { ValidationError } from "../lib/feeds/service.js";
import { render } from "../lib/html/template.js";
import {
  renderEntryRows,
  renderFeedPage,
  renderNotFoundPage,
  renderValidationErrors,
} from "../lib/feeds/views.js";
import { Controller } from "../lib/rest/controller.js";
import Request from "../lib/rest/request.js";
import { RssChannel, rssRoute } from "../lib/rss/index.js";

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

/** Absolute URL the request came in on, used for `<atom:link rel="self">`. */
function requestUrl(protocol: string, host: string | undefined, originalUrl: string): string {
  return host === undefined ? originalUrl : `${protocol}://${host}${originalUrl}`;
}

/**
 * Express 5 types a param as `string | string[]`, since a repeatable segment
 * can match more than once. `:slug` never does, and a non-string value could not
 * name a feed anyway, so anything else is treated as absent.
 */
export function pathParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Loads the requested feed, or `undefined` so `rssRoute` answers a 404. */
export async function feedChannel(req: Request<Dependencies>): Promise<RssChannel | undefined> {
  const slug = pathParam(req.params.slug);
  if (slug === undefined) {
    return undefined;
  }
  const loaded = await findFeedWithEntries(req.deps.db, slug);
  if (loaded === undefined) {
    return undefined;
  }
  return toRssFeed(loaded, {
    // headers.host keeps the port, which req.host drops.
    selfLink: requestUrl(req.protocol, req.headers.host, req.originalUrl),
  });
}

/** The browsable page for one feed. */
export function feedPageHandler(req: Request<Dependencies>, res: express.Response): void {
  void (async () => {
    const slug = pathParam(req.params.slug);
    try {
      const loaded = slug === undefined ? undefined : await findFeedWithEntries(req.deps.db, slug);
      if (loaded === undefined) {
        res
          .status(404)
          .set("Content-Type", HTML_CONTENT_TYPE)
          .send(renderNotFoundPage("That feed does not exist."));
        return;
      }
      res.set("Content-Type", HTML_CONTENT_TYPE).send(renderFeedPage(loaded.feed, loaded.entries));
    } catch (error) {
      console.error(`Failed to render the page for feed "${String(slug)}"`, error);
      res.status(500).set("Content-Type", HTML_CONTENT_TYPE).send("<h1>Something went wrong</h1>");
    }
  })();
}

/**
 * Points HTMX at the error container instead of the entry list.
 *
 * The response keeps its real status code; the page opts 4xx bodies back into
 * swapping with an `htmx:beforeSwap` handler.
 */
function retargetToErrors(res: express.Response, status: number): express.Response {
  return res.status(status).set({
    "Content-Type": HTML_CONTENT_TYPE,
    "HX-Retarget": "#errors",
    "HX-Reswap": "innerHTML",
  });
}

/** Creates an entry from the HTML form and returns the refreshed entry list. */
export function createEntryFragmentHandler(
  req: Request<Dependencies>,
  res: express.Response
): void {
  void (async () => {
    const slug = pathParam(req.params.slug);
    if (slug === undefined) {
      retargetToErrors(res, 404).send(
        renderValidationErrors([{ field: "feed", message: "was not named in the request" }])
      );
      return;
    }
    try {
      await createEntryFromRequest(req.deps.db, slug, req.body);
      const loaded = await findFeedWithEntries(req.deps.db, slug);
      const entries = loaded?.entries ?? [];
      res
        .status(201)
        .set("Content-Type", HTML_CONTENT_TYPE)
        .send(`${renderEntryRows(slug, entries).html}\n${render("errors-cleared", {})}`);
    } catch (error) {
      if (error instanceof ValidationError) {
        retargetToErrors(res, 400).send(renderValidationErrors(error.issues));
        return;
      }
      if (error instanceof FeedNotFoundError) {
        retargetToErrors(res, 404).send(
          renderValidationErrors([{ field: "feed", message: "does not exist" }])
        );
        return;
      }
      if (error instanceof DuplicateGuidError) {
        retargetToErrors(res, 409).send(
          renderValidationErrors([{ field: "guid", message: "is already used in this feed" }])
        );
        return;
      }
      console.error(`Failed to create an entry in feed "${slug}" from the form`, error);
      retargetToErrors(res, 500).send(
        renderValidationErrors([{ field: "entry", message: "could not be created" }])
      );
    }
  })();
}

/**
 * `/feeds/tech.xml` serves RSS; `/feeds/tech` serves the page a person reads.
 *
 * Order matters and is the whole reason these live in one controller. Express
 * matches in registration order and `:slug` swallows a trailing `.xml` into the
 * parameter, so the suffixed route has to be offered first or every reader
 * subscribing to `.xml` would get HTML.
 */
const FeedsController: Controller<Dependencies> = {
  basePath: "/feeds",
  routes: [
    rssRoute("/:slug.xml", feedChannel),
    { path: "/:slug", method: "GET", handler: feedPageHandler },
    { path: "/:slug/entries", method: "POST", handler: createEntryFragmentHandler },
  ],
};

export default FeedsController;
