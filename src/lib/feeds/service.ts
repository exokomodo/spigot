import Database from "../database.js";
import { SAFE_PROTOCOL_LIST, isSafeHttpUrl } from "../html/url.js";
import {
  DuplicateSlugError,
  FeedRow,
  FeedSummaryRow,
  NewFeed,
  createFeed,
  listFeedSummaries,
} from "./repository.js";
import { toSlug } from "./slug.js";

/**
 * Validation and the create/list operations, shared by the JSON API and the
 * HTML pages. Both surfaces call these; only the rendering differs, so the two
 * cannot drift on what a valid feed is.
 */

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

/**
 * Derives the slug from the title, complaining about the title when nothing
 * usable comes out.
 *
 * The complaint lands on `title` rather than `slug` because that is the field
 * the caller actually filled in — an error about a slug would name something
 * they were never asked for. An already-empty title is left alone, since
 * {@link validateTitle} has said the useful thing about it.
 */
function deriveSlug(title: string, issues: ValidationIssue[]): string {
  const slug = toSlug(title);
  if (slug.length === 0 && title.length > 0) {
    issues.push({
      field: "title",
      message: "must contain at least one letter or digit, since the feed's address comes from it",
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
 *
 * A `slug` in the body is ignored. The slug is always derived from the title,
 * so a feed has exactly one name to keep straight and the two can never
 * disagree.
 */
export function parseNewFeed(body: unknown): NewFeed {
  const fields: Record<string, unknown> =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  const issues: ValidationIssue[] = [];
  const title = validateTitle(readString(fields.title), issues);
  const slug = deriveSlug(title, issues);

  const description = readString(fields.description)?.trim() ?? "";
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    issues.push({
      field: "description",
      message: `must be at most ${String(DESCRIPTION_MAX_LENGTH)} characters`,
    });
  }

  // A feed's link reaches an href on the index, so it needs the same scheme
  // check an entry url gets. The render layer already refuses to link an unsafe
  // one, but storing it is still wrong: the value also goes out as the RSS
  // channel `<link>`, where a reader follows it under its own rules.
  const link = readString(fields.link)?.trim() ?? "";
  if (link.length > 0 && !isSafeHttpUrl(link)) {
    issues.push({ field: "link", message: `must be an absolute ${SAFE_PROTOCOL_LIST} URL` });
  }

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
