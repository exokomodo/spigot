import Dependencies from "../lib/dependencies.js";
import { findFeedWithEntries, toRssFeed } from "../lib/feeds/index.js";
import { Controller } from "../lib/rest/controller.js";
import Request from "../lib/rest/request.js";
import { RssChannel, rssRoute } from "../lib/rss/index.js";

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

/**
 * Both `/feeds/tech.xml` and `/feeds/tech` serve the same feed: readers expect
 * the extension, people typing a URL usually omit it.
 *
 * Order matters. Express matches routes in registration order, and `:slug`
 * happily swallows a trailing `.xml` into the parameter, so the suffixed route
 * has to be offered first or it would never be reached.
 */
const FeedsController: Controller<Dependencies> = {
  basePath: "/feeds",
  routes: [rssRoute("/:slug.xml", feedChannel), rssRoute("/:slug", feedChannel)],
};

export default FeedsController;
