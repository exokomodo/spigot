import Database from "../database.js";
import {
  DuplicateSlugError,
  FeedRow,
  FeedSummaryRow,
  NewFeed,
  createFeed,
  listFeedSummaries,
} from "./repository.js";

/**
 * Validation and the create/list operations, shared by the JSON API and the
 * HTML pages. Both surfaces call these; only the rendering differs, so the two
 * cannot drift on what a valid feed is.
 */

/**
 * A slug appears in `/feeds/<slug>.xml`, so it has to survive a URL untouched.
 * Lowercase alphanumerics in hyphen-separated groups: no leading, trailing or
 * doubled hyphens, nothing needing percent-encoding, and no case for two slugs
 * to differ only by.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SLUG_MAX_LENGTH = 100;
export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;

/** A field-level complaint, shaped for both a JSON body and a form error list. */
export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

export class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** Reads a field that should be a string, tolerating the `undefined` of an absent key. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validateSlug(raw: string | undefined, issues: ValidationIssue[]): string {
  const slug = raw?.trim() ?? "";
  if (slug.length === 0) {
    issues.push({ field: "slug", message: "is required" });
  } else if (slug.length > SLUG_MAX_LENGTH) {
    issues.push({
      field: "slug",
      message: `must be at most ${String(SLUG_MAX_LENGTH)} characters`,
    });
  } else if (!SLUG_PATTERN.test(slug)) {
    issues.push({
      field: "slug",
      message:
        "must be lowercase letters and digits separated by single hyphens, such as my-feed-name",
    });
  }
  return slug;
}

function validateTitle(raw: string | undefined, issues: ValidationIssue[]): string {
  const title = raw?.trim() ?? "";
  if (title.length === 0) {
    issues.push({ field: "title", message: "is required" });
  } else if (title.length > TITLE_MAX_LENGTH) {
    issues.push({
      field: "title",
      message: `must be at most ${String(TITLE_MAX_LENGTH)} characters`,
    });
  }
  return title;
}

/**
 * Validates an untrusted request body into a `NewFeed`.
 *
 * Takes `unknown` rather than a typed body: the value came off the wire, and
 * typing it as an object would be a claim this function exists to establish.
 */
export function parseNewFeed(body: unknown): NewFeed {
  const fields: Record<string, unknown> =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  const issues: ValidationIssue[] = [];
  const slug = validateSlug(readString(fields.slug), issues);
  const title = validateTitle(readString(fields.title), issues);

  const description = readString(fields.description)?.trim() ?? "";
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    issues.push({
      field: "description",
      message: `must be at most ${String(DESCRIPTION_MAX_LENGTH)} characters`,
    });
  }

  const link = readString(fields.link)?.trim() ?? "";
  const language = readString(fields.language)?.trim() ?? "";

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }

  return {
    slug,
    title,
    description,
    link: link.length > 0 ? link : undefined,
    language: language.length > 0 ? language : undefined,
  };
}

/** Validates and stores a feed. Throws `ValidationError` or `DuplicateSlugError`. */
export async function createFeedFromRequest(db: Database, body: unknown): Promise<FeedRow> {
  return createFeed(db, parseNewFeed(body));
}

/** Every feed with its entry count, newest first. */
export async function listFeeds(db: Database): Promise<readonly FeedSummaryRow[]> {
  return listFeedSummaries(db);
}

export { DuplicateSlugError };
