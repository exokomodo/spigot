import Database from "../database.js";
import { SAFE_PROTOCOL_LIST, isSafeHttpUrl } from "../html/url.js";
import {
  DuplicateGuidError,
  EntryRow,
  FeedRow,
  NewEntry,
  createEntry,
  deleteEntryById,
  findFeedBySlug,
} from "./repository.js";
import { FeedNotFoundError, ValidationError, ValidationIssue } from "./service.js";

/**
 * Validation and creation for entries, shared by the JSON API and the HTML
 * form, exactly as `service.ts` is for feeds.
 */

export const ENTRY_TITLE_MAX_LENGTH = 500;
export const ENTRY_URL_MAX_LENGTH = 2000;
export const ENTRY_GUID_MAX_LENGTH = 500;
export const ENTRY_DESCRIPTION_MAX_LENGTH = 20000;
export const ENTRY_AUTHOR_MAX_LENGTH = 200;

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validateEntryUrl(raw: string | undefined, issues: ValidationIssue[]): string {
  const url = raw?.trim() ?? "";
  if (url.length === 0) {
    issues.push({ field: "url", message: "is required" });
  } else if (url.length > ENTRY_URL_MAX_LENGTH) {
    issues.push({
      field: "url",
      message: `must be at most ${String(ENTRY_URL_MAX_LENGTH)} characters`,
    });
  } else if (!isSafeHttpUrl(url)) {
    // Rejected here as well as at render time: a stored javascript: URL is a
    // waiting XSS, so it should never reach the database in the first place.
    issues.push({ field: "url", message: `must be an absolute ${SAFE_PROTOCOL_LIST} URL` });
  }
  return url;
}

function validateEntryTitle(raw: string | undefined, issues: ValidationIssue[]): string {
  const title = raw?.trim() ?? "";
  if (title.length === 0) {
    issues.push({ field: "title", message: "is required" });
  } else if (title.length > ENTRY_TITLE_MAX_LENGTH) {
    issues.push({
      field: "title",
      message: `must be at most ${String(ENTRY_TITLE_MAX_LENGTH)} characters`,
    });
  }
  return title;
}

/**
 * Normalizes a publication date to the format the schema stores.
 *
 * This has to happen before the INSERT. Migration 0002 put
 * `CHECK (published_at IS NULL OR datetime(published_at) IS NOT NULL)` on the
 * column, so an unparseable value reaches SQLite as a constraint violation —
 * which is a 500, when a client sending a bad date is plainly a 400.
 *
 * Storing `toISOString()` rather than the caller's spelling also means every row
 * holds the same shape the migration's own default emits, which is the shape
 * `datetime()` was verified to accept.
 */
function validatePublishedAt(
  raw: string | undefined,
  issues: ValidationIssue[],
  now: Date
): string {
  const value = raw?.trim() ?? "";
  if (value.length === 0) {
    return now.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    issues.push({
      field: "publishedAt",
      message: "must be a date, such as 2026-08-02T10:00:00Z",
    });
    return now.toISOString();
  }
  return parsed.toISOString();
}

/** An enclosure is all three parts or none, matching how the mapper reads one back. */
function validateEnclosure(
  fields: Record<string, unknown>,
  issues: ValidationIssue[]
): Pick<NewEntry, "enclosureUrl" | "enclosureType" | "enclosureLength"> {
  const url = readString(fields.enclosureUrl)?.trim() ?? "";
  const type = readString(fields.enclosureType)?.trim() ?? "";
  const rawLength = fields.enclosureLength;
  const lengthText =
    typeof rawLength === "number" ? String(rawLength) : (readString(rawLength) ?? "");

  const provided = [url, type, lengthText].filter((part) => part.length > 0);
  if (provided.length === 0) {
    return {};
  }
  if (provided.length < 3) {
    issues.push({
      field: "enclosure",
      message: "needs enclosureUrl, enclosureType and enclosureLength together, or none of them",
    });
    return {};
  }

  if (!isSafeHttpUrl(url)) {
    issues.push({
      field: "enclosureUrl",
      message: `must be an absolute ${SAFE_PROTOCOL_LIST} URL`,
    });
  }

  const length = Number(lengthText);
  if (!Number.isInteger(length) || length <= 0) {
    issues.push({ field: "enclosureLength", message: "must be a positive whole number of bytes" });
  }

  return { enclosureUrl: url, enclosureType: type, enclosureLength: length };
}

/**
 * Validates an untrusted request body into a `NewEntry`.
 *
 * `now` is injectable so a test can assert the default publication date without
 * racing the clock.
 */
export function parseNewEntry(feed: FeedRow, body: unknown, now: Date = new Date()): NewEntry {
  const fields: Record<string, unknown> =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  const issues: ValidationIssue[] = [];
  const url = validateEntryUrl(readString(fields.url), issues);
  const title = validateEntryTitle(readString(fields.title), issues);
  const publishedAt = validatePublishedAt(readString(fields.publishedAt), issues, now);

  // An entry with no guid of its own is identified by where it lives, which is
  // what `isPermaLink` means — so the default guid and the flag agree.
  const rawGuid = readString(fields.guid)?.trim() ?? "";
  const guid = rawGuid.length > 0 ? rawGuid : url;
  if (guid.length > ENTRY_GUID_MAX_LENGTH) {
    issues.push({
      field: "guid",
      message: `must be at most ${String(ENTRY_GUID_MAX_LENGTH)} characters`,
    });
  }

  const description = readString(fields.description)?.trim() ?? "";
  if (description.length > ENTRY_DESCRIPTION_MAX_LENGTH) {
    issues.push({
      field: "description",
      message: `must be at most ${String(ENTRY_DESCRIPTION_MAX_LENGTH)} characters`,
    });
  }

  const author = readString(fields.author)?.trim() ?? "";
  if (author.length > ENTRY_AUTHOR_MAX_LENGTH) {
    issues.push({
      field: "author",
      message: `must be at most ${String(ENTRY_AUTHOR_MAX_LENGTH)} characters`,
    });
  }

  const categories = readString(fields.categories)?.trim() ?? "";
  const enclosure = validateEnclosure(fields, issues);

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }

  return {
    feedId: feed.id,
    guid,
    guidIsPermalink: rawGuid.length === 0,
    url,
    title,
    description: description.length > 0 ? description : undefined,
    author: author.length > 0 ? author : undefined,
    categories: categories.length > 0 ? categories : undefined,
    publishedAt,
    ...enclosure,
  };
}

/** Raised when the id in the path names no entry in the feed, so callers can answer 404. */
export class EntryNotFoundError extends Error {
  /** As it appeared in the path, since an unparseable id is one of the ways to get here. */
  readonly entryId: string;

  constructor(entryId: string) {
    super(`No entry "${entryId}" exists in this feed`);
    this.name = "EntryNotFoundError";
    this.entryId = entryId;
  }
}

/**
 * Reads a row id out of a path segment, or `undefined` when the segment is not
 * one.
 *
 * Digits only, rather than `Number()` on its own: `" 7 "`, `"7e0"` and `"0x7"`
 * all convert to 7, so a URL naming an entry that way names it by coincidence,
 * and answering it would make three spellings of every entry's address.
 */
export function parseEntryId(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Deletes one entry from the feed named by `slug`, returning the feed it left.
 *
 * Throws `FeedNotFoundError` or `EntryNotFoundError`, which the controllers both
 * answer 404. The feed is resolved first and the delete is scoped to it, so an
 * id belonging to another feed is a miss here rather than a deletion there.
 */
export async function deleteEntryFromRequest(
  db: Database,
  slug: string,
  rawEntryId: string
): Promise<FeedRow> {
  const feed = await findFeedBySlug(db, slug);
  if (feed === undefined) {
    throw new FeedNotFoundError(slug);
  }
  const entryId = parseEntryId(rawEntryId);
  if (entryId === undefined || !(await deleteEntryById(db, feed.id, entryId))) {
    throw new EntryNotFoundError(rawEntryId);
  }
  return feed;
}

/**
 * Validates and stores an entry against the feed named by `slug`.
 *
 * Throws `FeedNotFoundError`, `ValidationError` or `DuplicateGuidError`, which
 * the controllers turn into 404, 400 and 409 respectively.
 */
export async function createEntryFromRequest(
  db: Database,
  slug: string,
  body: unknown,
  now: Date = new Date()
): Promise<{ readonly feed: FeedRow; readonly entry: EntryRow }> {
  const feed = await findFeedBySlug(db, slug);
  if (feed === undefined) {
    throw new FeedNotFoundError(slug);
  }
  return { feed, entry: await createEntry(db, parseNewEntry(feed, body, now)) };
}

export { DuplicateGuidError, FeedNotFoundError };
