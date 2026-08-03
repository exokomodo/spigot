import express from "express";
import Dependencies from "../lib/dependencies.js";
import { render } from "../lib/html/template.js";
import {
  DuplicateSlugError,
  ValidationError,
  createFeedFromRequest,
  listFeeds,
} from "../lib/feeds/service.js";
import { renderFeedRows, renderIndexPage, renderValidationErrors } from "../lib/feeds/views.js";
import { Controller } from "../lib/rest/controller.js";
import Request from "../lib/rest/request.js";

/**
 * The browser-facing pages. These share the service layer with the JSON API and
 * differ only in rendering: HTMX wants an HTML fragment back, not JSON, so the
 * two live in separate handlers rather than one that content-negotiates.
 */

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * Points HTMX at the error container instead of the table.
 *
 * The response still carries its real status code — a rejected form is a 400,
 * not a 200 that happens to contain an apology. HTMX ignores 4xx bodies by
 * default, so the page opts back in via an `htmx:beforeSwap` handler.
 */
function retargetToErrors(res: express.Response, status: number): express.Response {
  return res.status(status).set({
    "Content-Type": HTML_CONTENT_TYPE,
    "HX-Retarget": "#errors",
    "HX-Reswap": "innerHTML",
  });
}

export function indexHandler(req: Request<Dependencies>, res: express.Response): void {
  void (async () => {
    try {
      const rows = await listFeeds(req.deps.db);
      res.set("Content-Type", HTML_CONTENT_TYPE).send(renderIndexPage(rows));
    } catch (error) {
      console.error("Failed to render the index page", error);
      res.status(500).set("Content-Type", HTML_CONTENT_TYPE).send("<h1>Something went wrong</h1>");
    }
  })();
}

/**
 * Creates a feed from the HTML form and returns the refreshed table body.
 *
 * Success also clears the error box through an out-of-band swap, so a fixed
 * submission does not leave the previous complaint sitting on the page.
 */
export function createFeedFragmentHandler(req: Request<Dependencies>, res: express.Response): void {
  void (async () => {
    try {
      await createFeedFromRequest(req.deps.db, req.body);
      const rows = await listFeeds(req.deps.db);
      res
        .status(201)
        .set("Content-Type", HTML_CONTENT_TYPE)
        .send(`${renderFeedRows(rows).html}\n${render("errors-cleared", {})}`);
    } catch (error) {
      if (error instanceof ValidationError) {
        retargetToErrors(res, 400).send(renderValidationErrors(error.issues));
        return;
      }
      if (error instanceof DuplicateSlugError) {
        // The conflict is on the derived slug, but the form only offered a
        // title, so that is the field the reader can actually change.
        retargetToErrors(res, 409).send(
          renderValidationErrors([
            { field: "title", message: `is already taken by the feed at /feeds/${error.slug}` },
          ])
        );
        return;
      }
      console.error("Failed to create a feed from the form", error);
      retargetToErrors(res, 500).send(
        renderValidationErrors([{ field: "feed", message: "could not be created" }])
      );
    }
  })();
}

const PagesController: Controller<Dependencies> = {
  basePath: "/",
  routes: [
    { path: "/", method: "GET", handler: indexHandler },
    { path: "/feeds", method: "POST", handler: createFeedFragmentHandler },
  ],
};

export default PagesController;
