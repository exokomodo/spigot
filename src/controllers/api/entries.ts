import express from "express";
import Dependencies from "../../lib/dependencies.js";
import {
  DuplicateGuidError,
  EntryNotFoundError,
  FeedNotFoundError,
  createEntryFromRequest,
  deleteEntryFromRequest,
  parseStripFlag,
} from "../../lib/feeds/entry-service.js";
import { toEntryJson } from "../../lib/feeds/presenter.js";
import { ValidationError } from "../../lib/feeds/service.js";
import { Controller } from "../../lib/rest/controller.js";
import Request from "../../lib/rest/request.js";
import { pathParam } from "../feeds.js";
import { ApiErrorBody } from "./feeds.js";

/** The JSON API for entries, sharing its service layer with the HTML form. */

function sendError(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  details?: readonly { readonly field: string; readonly message: string }[]
): void {
  const body: ApiErrorBody = { error: { code, message, details } };
  res.status(status).json(body);
}

/**
 * Turns a thrown error into a response.
 *
 * The ones the service raises deliberately become 4xx; anything else is a bug
 * here rather than a caller mistake, so it is logged and answered 500 without
 * echoing its message back.
 */
export function sendEntryError(res: express.Response, error: unknown, context: string): void {
  if (error instanceof ValidationError) {
    sendError(res, 400, "invalid_request", "The entry could not be created", error.issues);
    return;
  }
  if (error instanceof FeedNotFoundError) {
    sendError(res, 404, "feed_not_found", error.message);
    return;
  }
  if (error instanceof EntryNotFoundError) {
    sendError(res, 404, "entry_not_found", error.message);
    return;
  }
  if (error instanceof DuplicateGuidError) {
    sendError(res, 409, "guid_taken", error.message);
    return;
  }
  console.error(context, error);
  sendError(res, 500, "internal_error", "Something went wrong");
}

export function createEntryHandler(req: Request<Dependencies>, res: express.Response): void {
  void (async () => {
    const slug = pathParam(req.params.slug);
    if (slug === undefined) {
      sendError(res, 404, "feed_not_found", "No feed was named in the request");
      return;
    }
    try {
      /*
       * `strip` says how to read the request, not what the entry is, so it goes
       * in the query string and the body stays a description of the entry.
       * The HTML form reads the same flag from its body instead — a form has no
       * query string to put it in — which is each transport using what it has,
       * not an inconsistency.
       *
       * Absent means off, so a caller written before this existed keeps getting
       * back exactly the URL it sent.
       */
      const stripQuery = parseStripFlag(req.query.strip);
      const { entry } = await createEntryFromRequest(req.deps.db, slug, req.body, { stripQuery });
      res
        .status(201)
        .location(`/api/feeds/${slug}/entries/${String(entry.id)}`)
        .json({ entry: toEntryJson(entry) });
    } catch (error) {
      sendEntryError(res, error, `Failed to create an entry in feed "${slug}"`);
    }
  })();
}

/** Deletes one entry from one feed, answering 204 with nothing left to describe. */
export function deleteEntryHandler(req: Request<Dependencies>, res: express.Response): void {
  void (async () => {
    const slug = pathParam(req.params.slug);
    const entryId = pathParam(req.params.entryId);
    if (slug === undefined || entryId === undefined) {
      sendError(res, 404, "entry_not_found", "No entry was named in the request");
      return;
    }
    try {
      await deleteEntryFromRequest(req.deps.db, slug, entryId);
      res.status(204).end();
    } catch (error) {
      sendEntryError(res, error, `Failed to delete entry "${entryId}" from feed "${slug}"`);
    }
  })();
}

const ApiEntriesController: Controller<Dependencies> = {
  basePath: "/api/feeds",
  routes: [
    { path: "/:slug/entries", method: "POST", handler: createEntryHandler },
    { path: "/:slug/entries/:entryId", method: "DELETE", handler: deleteEntryHandler },
  ],
};

export default ApiEntriesController;
