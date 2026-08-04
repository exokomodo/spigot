import express from "express";
import Dependencies from "../lib/dependencies.js";
import {
  DuplicateGuidError,
  EntryNotFoundError,
  FeedNotFoundError,
  createEntryFromRequest,
  deleteEntryFromRequest,
  findEntryFromRequest,
  stripFlagFromBody,
  updateEntryFromRequest,
} from "../lib/feeds/entry-service.js";
import { findFeedWithEntries, toRssFeed } from "../lib/feeds/index.js";
import { ValidationError } from "../lib/feeds/service.js";
import { render } from "../lib/html/template.js";
import {
  renderEntryEditForm,
  renderEntryRow,
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

/**
 * Turns a thrown error into an error-box fragment, the way `sendEntryError`
 * does for the JSON API.
 *
 * The ones the service raises are caller mistakes and keep a real 4xx, which
 * the page opts back into swapping. Anything else is a bug here, so it is
 * logged and answered 500 without repeating itself onto the page.
 */
function sendFragmentError(
  res: express.Response,
  error: unknown,
  action: string,
  context: string
): void {
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
  if (error instanceof EntryNotFoundError) {
    // Two people on the same page, or one person clicking twice: the entry is
    // gone either way, and that is a 404 rather than a failure.
    retargetToErrors(res, 404).send(
      renderValidationErrors([{ field: "entry", message: "no longer exists" }])
    );
    return;
  }
  if (error instanceof DuplicateGuidError) {
    retargetToErrors(res, 409).send(
      renderValidationErrors([{ field: "guid", message: "is already used in this feed" }])
    );
    return;
  }
  console.error(context, error);
  retargetToErrors(res, 500).send(
    renderValidationErrors([{ field: "entry", message: `could not be ${action}` }])
  );
}

/** The pair every row-level route addresses, or `undefined` when either is missing. */
function entryTarget(
  req: Request<Dependencies>
): { readonly slug: string; readonly entryId: string } | undefined {
  const slug = pathParam(req.params.slug);
  const entryId = pathParam(req.params.entryId);
  return slug === undefined || entryId === undefined ? undefined : { slug, entryId };
}

/** Answers a request that named no entry to act on. */
function sendUnnamedEntryError(res: express.Response): void {
  retargetToErrors(res, 404).send(
    renderValidationErrors([{ field: "entry", message: "was not named in the request" }])
  );
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
      /*
       * The form's checkbox is checked by default, but an unchecked box posts
       * nothing at all, so absent-means-off gives the page the opposite default
       * from the API without either side special-casing the other.
       *
       * The flag rides in the body because a form has no query string to put it
       * in; the JSON API reads the same flag from its query string. Both hand
       * the service the same option.
       */
      const stripQuery = stripFlagFromBody(req.body);
      await createEntryFromRequest(req.deps.db, slug, req.body, { stripQuery });
      const loaded = await findFeedWithEntries(req.deps.db, slug);
      const entries = loaded?.entries ?? [];
      res
        .status(201)
        .set("Content-Type", HTML_CONTENT_TYPE)
        .send(`${renderEntryRows(slug, entries).html}\n${render("errors-cleared", {})}`);
    } catch (error) {
      sendFragmentError(
        res,
        error,
        "created",
        `Failed to create an entry in feed "${slug}" from the form`
      );
    }
  })();
}

/** Deletes one entry and returns the refreshed entry list. */
export function deleteEntryFragmentHandler(
  req: Request<Dependencies>,
  res: express.Response
): void {
  void (async () => {
    const target = entryTarget(req);
    if (target === undefined) {
      sendUnnamedEntryError(res);
      return;
    }
    const { slug, entryId } = target;
    try {
      await deleteEntryFromRequest(req.deps.db, slug, entryId);
      const loaded = await findFeedWithEntries(req.deps.db, slug);
      res
        .set("Content-Type", HTML_CONTENT_TYPE)
        .send(
          `${renderEntryRows(slug, loaded?.entries ?? []).html}\n${render("errors-cleared", {})}`
        );
    } catch (error) {
      sendFragmentError(
        res,
        error,
        "deleted",
        `Failed to delete entry "${entryId}" from feed "${slug}"`
      );
    }
  })();
}

/** Swaps one row into the form that edits it. */
export function editEntryFragmentHandler(req: Request<Dependencies>, res: express.Response): void {
  void (async () => {
    const target = entryTarget(req);
    if (target === undefined) {
      sendUnnamedEntryError(res);
      return;
    }
    const { slug, entryId } = target;
    try {
      const entry = await findEntryFromRequest(req.deps.db, slug, entryId);
      res.set("Content-Type", HTML_CONTENT_TYPE).send(renderEntryEditForm(slug, entry).html);
    } catch (error) {
      sendFragmentError(
        res,
        error,
        "edited",
        `Failed to render the edit form for entry "${entryId}" of feed "${slug}"`
      );
    }
  })();
}

/**
 * One row on its own, which is how Cancel puts back what it found.
 *
 * The row is re-read rather than remembered by the form, so a cancelled edit
 * shows what is stored now and not what was stored when the form opened.
 */
export function entryRowFragmentHandler(req: Request<Dependencies>, res: express.Response): void {
  void (async () => {
    const target = entryTarget(req);
    if (target === undefined) {
      sendUnnamedEntryError(res);
      return;
    }
    const { slug, entryId } = target;
    try {
      const entry = await findEntryFromRequest(req.deps.db, slug, entryId);
      res.set("Content-Type", HTML_CONTENT_TYPE).send(renderEntryRow(slug, entry).html);
    } catch (error) {
      sendFragmentError(
        res,
        error,
        "shown",
        `Failed to render entry "${entryId}" of feed "${slug}"`
      );
    }
  })();
}

/**
 * Saves the edit form and returns the row it becomes.
 *
 * Only the edited row is sent back, so a save does not re-render the other
 * entries. An edit that changes the publication date therefore leaves the row
 * where it was until the page is loaded again, which is a smaller surprise than
 * having a row jump out from under the cursor that saved it.
 */
export function updateEntryFragmentHandler(
  req: Request<Dependencies>,
  res: express.Response
): void {
  void (async () => {
    const target = entryTarget(req);
    if (target === undefined) {
      sendUnnamedEntryError(res);
      return;
    }
    const { slug, entryId } = target;
    try {
      const entry = await updateEntryFromRequest(req.deps.db, slug, entryId, req.body);
      res
        .set("Content-Type", HTML_CONTENT_TYPE)
        .send(`${renderEntryRow(slug, entry).html}\n${render("errors-cleared", {})}`);
    } catch (error) {
      sendFragmentError(
        res,
        error,
        "saved",
        `Failed to save entry "${entryId}" of feed "${slug}" from the form`
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
    { path: "/:slug/entries/:entryId/edit", method: "GET", handler: editEntryFragmentHandler },
    { path: "/:slug/entries/:entryId", method: "GET", handler: entryRowFragmentHandler },
    { path: "/:slug/entries/:entryId", method: "PATCH", handler: updateEntryFragmentHandler },
    { path: "/:slug/entries/:entryId", method: "DELETE", handler: deleteEntryFragmentHandler },
  ],
};

export default FeedsController;
