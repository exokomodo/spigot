import express from "express";
import Dependencies from "../../lib/dependencies.js";
import { toFeedJson, toFeedSummaryJson } from "../../lib/feeds/presenter.js";
import {
  DuplicateSlugError,
  ValidationError,
  createFeedFromRequest,
  listFeeds,
} from "../../lib/feeds/service.js";
import { Controller } from "../../lib/rest/controller.js";
import Request from "../../lib/rest/request.js";

/**
 * The JSON API. The HTML pages call the same service functions and differ only
 * in how they render the result, so the two surfaces cannot disagree about what
 * a valid feed is.
 */

/** Every error response has this shape, whatever went wrong. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly { readonly field: string; readonly message: string }[];
  };
}

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
 * Only the two errors the service raises deliberately become 4xx; anything else
 * is a bug here rather than a caller mistake, so it is logged and answered 500
 * without echoing its message back to the client.
 */
export function sendServiceError(res: express.Response, error: unknown, context: string): void {
  if (error instanceof ValidationError) {
    sendError(res, 400, "invalid_request", "The feed could not be created", error.issues);
    return;
  }
  if (error instanceof DuplicateSlugError) {
    sendError(res, 409, "slug_taken", error.message);
    return;
  }
  console.error(context, error);
  sendError(res, 500, "internal_error", "Something went wrong");
}

export function listFeedsHandler(req: Request<Dependencies>, res: express.Response): void {
  void (async () => {
    try {
      const rows = await listFeeds(req.deps.db);
      res.json({ feeds: rows.map(toFeedSummaryJson) });
    } catch (error) {
      sendServiceError(res, error, "Failed to list feeds");
    }
  })();
}

export function createFeedHandler(req: Request<Dependencies>, res: express.Response): void {
  void (async () => {
    try {
      const created = await createFeedFromRequest(req.deps.db, req.body);
      res
        .status(201)
        .location(`/api/feeds/${created.slug}`)
        .json({ feed: toFeedJson(created, 0) });
    } catch (error) {
      sendServiceError(res, error, "Failed to create feed");
    }
  })();
}

const ApiFeedsController: Controller<Dependencies> = {
  basePath: "/api/feeds",
  routes: [
    { path: "/", method: "GET", handler: listFeedsHandler },
    { path: "/", method: "POST", handler: createFeedHandler },
  ],
};

export default ApiFeedsController;
