import Database from "../database.js";
import { stripQueryString } from "../html/strip-query.js";
import { SAFE_PROTOCOL_LIST, isSafeHttpUrl } from "../html/url.js";
import {
  DuplicateGuidError,
  EntryRow,
  EntryUpdate,
  FeedRow,
  NewEntry,
  createEntry,
  deleteEntryById,
  findEntryById,
  findFeedBySlug,
  updateEntry,
} from "./repository.js";
import { FeedNotFoundError, ValidationError, ValidationIssue } from "./service.js";

/**
 * Validation, creation and editing for entries, shared by the JSON API and the
 * HTML form, exactly as `service.ts` is for feeds.
 */

export const ENTRY_TITLE_MAX_LENGTH = 500;
export const ENTRY_URL_MAX_LENGTH = 2000;
export const ENTRY_GUID_MAX_LENGTH = 500;
export const ENTRY_DESCRIPTION_MAX_LENGTH = 20000;
export const ENTRY_AUTHOR_MAX_LENGTH = 200;

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** An untrusted body as something with keys, so a non-object simply has none. */
function readFields(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/** The length rule every free-text column shares, reported against its own field name. */
function validateMaxLength(
  field: string,
  value: string,
  max: number,
  issues: ValidationIssue[]
): string {
  if (value.length > max) {
    issues.push({ field, message: `must be at most ${String(max)} characters` });
  }
  return value;
}

function validateEntryUrl(
  raw: string | undefined,
  issues: ValidationIssue[],
  stripQuery: boolean
): string {
  const trimmed = raw?.trim() ?? "";
  // Stripped before the checks below rather than after, so the length limit and
  // the scheme check both judge the URL that will actually be stored — a
  // tracking-laden link is often over the limit only because of its query.
  const url = stripQuery ? stripQueryString(trimmed) : trimmed;
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
 * How to read a request, as opposed to what the request says.
 *
 * These are choices the transport makes on the caller's behalf, so they travel
 * beside the body rather than inside it — a request cannot ask to be parsed
 * differently by adding a field to the entry it is submitting.
 */
export interface NewEntryOptions {
  /**
   * Drop the query string from the entry url before validating and storing it.
   *
   * Off by default. Callers that predate the flag keep storing exactly the URL
   * they send, and losing part of a URL is not something to do unasked.
   */
  readonly stripQuery?: boolean;
  /** The clock, injectable so a test can assert the default publication date without racing it. */
  readonly now?: Date;
}

/** Validates an untrusted request body into a `NewEntry`. */
export function parseNewEntry(
  feed: FeedRow,
  body: unknown,
  options: NewEntryOptions = {}
): NewEntry {
  const fields = readFields(body);
  const now = options.now ?? new Date();

  const issues: ValidationIssue[] = [];
  const url = validateEntryUrl(readString(fields.url), issues, options.stripQuery === true);
  const title = validateEntryTitle(readString(fields.title), issues);
  const publishedAt = validatePublishedAt(readString(fields.publishedAt), issues, now);

  // An entry with no guid of its own is identified by where it lives, which is
  // what `isPermaLink` means — so the default guid and the flag agree.
  //
  // `url` is the stripped one, because `validateEntryUrl` already ran. That
  // ordering is the point: a permalink guid claims to be the entry's address,
  // and one carrying a query the entry itself does not have would be a lie that
  // also changes which entries count as duplicates.
  const rawGuid = readString(fields.guid)?.trim() ?? "";
  const guid = validateMaxLength(
    "guid",
    rawGuid.length > 0 ? rawGuid : url,
    ENTRY_GUID_MAX_LENGTH,
    issues
  );

  const description = validateMaxLength(
    "description",
    readString(fields.description)?.trim() ?? "",
    ENTRY_DESCRIPTION_MAX_LENGTH,
    issues
  );

  const author = validateMaxLength(
    "author",
    readString(fields.author)?.trim() ?? "",
    ENTRY_AUTHOR_MAX_LENGTH,
    issues
  );

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

const TRUTHY_STRIP_VALUES: ReadonlySet<string> = new Set(["", "true", "1", "on"]);
const FALSY_STRIP_VALUES: ReadonlySet<string> = new Set(["false", "0", "off"]);

/** The accepted spellings, for the error a mistyped flag gets. */
export const STRIP_FLAG_VALUE_LIST = "true, 1, on, false, 0 or off";

/**
 * Reads the `strip` flag a request may carry, defaulting to off.
 *
 * A value that is neither spelling raises rather than being read as false. A
 * flag whose whole job is to remove something is the wrong place to guess: a
 * typo would quietly store the tracking parameters the caller asked to drop,
 * and nothing about the 201 would say so.
 *
 * `?strip` with no value arrives as an empty string and reads as on, since
 * writing the flag at all is the request.
 */
export function parseStripFlag(raw: unknown): boolean {
  if (raw === undefined) {
    return false;
  }
  // Anything other than a single string is a repeated or nested parameter,
  // which cannot be resolved into one answer and so is a mistake, not a value.
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
  if (value !== undefined && TRUTHY_STRIP_VALUES.has(value)) {
    return true;
  }
  if (value !== undefined && FALSY_STRIP_VALUES.has(value)) {
    return false;
  }
  throw new ValidationError([
    { field: "strip", message: `must be ${STRIP_FLAG_VALUE_LIST}, or be left off` },
  ]);
}

/**
 * Reads the `strip` flag out of a submitted form body.
 *
 * The HTML form has nowhere else to put it — a form posts fields, not query
 * strings — so the flag arrives beside the entry's own fields and is picked
 * back out here rather than left for `parseNewEntry` to mistake for one.
 */
export function stripFlagFromBody(body: unknown): boolean {
  const fields: Record<string, unknown> =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return parseStripFlag(fields.strip);
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
  options: NewEntryOptions = {}
): Promise<{ readonly feed: FeedRow; readonly entry: EntryRow }> {
  const feed = await findFeedBySlug(db, slug);
  if (feed === undefined) {
    throw new FeedNotFoundError(slug);
  }
  return { feed, entry: await createEntry(db, parseNewEntry(feed, body, options)) };
}

/** The three enclosure keys, which are validated together or not at all. */
const ENCLOSURE_FIELDS = ["enclosureUrl", "enclosureType", "enclosureLength"] as const;

/** {@link EntryUpdate} while it is still being assembled. */
type MutableEntryUpdate = { -readonly [Field in keyof EntryUpdate]: EntryUpdate[Field] };

/** Text that clears its column when blank, so an emptied form field empties the row. */
function clearWhenBlank(value: string): string | null {
  return value.length > 0 ? value : null;
}

/**
 * Validates an untrusted body into the columns it asks to change.
 *
 * Only keys the body actually carries are read, which is what makes this a
 * patch: the HTML form knows about four fields, and a replacement built from it
 * would blank the author, categories and enclosure of every entry it saved.
 *
 * `existing` is needed rather than merely the feed, because whether the guid
 * moves with the url depends on the row already stored.
 */
export function parseEntryUpdate(
  existing: EntryRow,
  body: unknown,
  now: Date = new Date()
): EntryUpdate {
  const fields = readFields(body);
  const issues: ValidationIssue[] = [];
  const update: MutableEntryUpdate = {};

  if (Object.hasOwn(fields, "url")) {
    // Never stripped, deliberately. Stripping is a choice about a URL arriving
    // from somewhere else; a url typed into the edit form is already the one the
    // author means, and silently shortening what they just typed would be the
    // surprise. An entry stored with a query it should not have is fixed by
    // editing that query out.
    const url = validateEntryUrl(readString(fields.url), issues, false);
    update.url = url;
    // A permalink guid *is* the entry's url — that is what `isPermaLink` claims
    // and what `parseNewEntry` stores — so moving the url has to move the guid
    // with it, or the feed goes on publishing a guid that resolves nowhere. An
    // entry with a guid of its own keeps it: readers have already filed the
    // item under that guid, and changing it republishes the item as a new one.
    if (existing.guid_is_permalink === 1) {
      update.guid = validateMaxLength("guid", url, ENTRY_GUID_MAX_LENGTH, issues);
    }
  }

  if (Object.hasOwn(fields, "title")) {
    update.title = validateEntryTitle(readString(fields.title), issues);
  }

  if (Object.hasOwn(fields, "description")) {
    update.description = clearWhenBlank(
      validateMaxLength(
        "description",
        readString(fields.description)?.trim() ?? "",
        ENTRY_DESCRIPTION_MAX_LENGTH,
        issues
      )
    );
  }

  if (Object.hasOwn(fields, "author")) {
    update.author = clearWhenBlank(
      validateMaxLength(
        "author",
        readString(fields.author)?.trim() ?? "",
        ENTRY_AUTHOR_MAX_LENGTH,
        issues
      )
    );
  }

  if (Object.hasOwn(fields, "categories")) {
    update.categories = clearWhenBlank(readString(fields.categories)?.trim() ?? "");
  }

  // A blank date leaves the stored one alone rather than clearing it or
  // defaulting to now, which is what `parseNewEntry` does with the same value.
  // The edit form's date field is empty until someone picks a date, because a
  // `datetime-local` input carries no zone: prefilling it with the stored UTC
  // instant would have the browser read it back as a local one and shift the
  // entry by the reader's offset every time it was saved.
  const publishedAt = readString(fields.publishedAt)?.trim() ?? "";
  if (publishedAt.length > 0) {
    update.publishedAt = validatePublishedAt(publishedAt, issues, now);
  }

  // All three parts or none, the same rule the mapper reads them back under —
  // so naming any one of them rewrites the set, and naming them all blank
  // removes the enclosure.
  if (ENCLOSURE_FIELDS.some((field) => Object.hasOwn(fields, field))) {
    const enclosure = validateEnclosure(fields, issues);
    update.enclosureUrl = enclosure.enclosureUrl ?? null;
    update.enclosureType = enclosure.enclosureType ?? null;
    update.enclosureLength = enclosure.enclosureLength ?? null;
  }

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return update;
}

/**
 * Loads one entry of the feed named by `slug`.
 *
 * Throws `FeedNotFoundError` or `EntryNotFoundError`, which the controllers
 * both answer 404. Resolving the feed first and scoping the lookup to it means
 * an id belonging to another feed is a miss rather than a peek at that feed.
 */
export async function findEntryFromRequest(
  db: Database,
  slug: string,
  rawEntryId: string
): Promise<EntryRow> {
  const feed = await findFeedBySlug(db, slug);
  if (feed === undefined) {
    throw new FeedNotFoundError(slug);
  }
  const entryId = parseEntryId(rawEntryId);
  const entry = entryId === undefined ? undefined : await findEntryById(db, feed.id, entryId);
  if (entry === undefined) {
    throw new EntryNotFoundError(rawEntryId);
  }
  return entry;
}

/**
 * Applies the fields a request carries to one entry, returning the stored row.
 *
 * Throws `FeedNotFoundError`, `EntryNotFoundError`, `ValidationError` or
 * `DuplicateGuidError`, which the controllers turn into 404, 404, 400 and 409.
 *
 * The row is read before it is written because the update is validated against
 * it — the guid rule in {@link parseEntryUpdate} needs to know what is stored.
 * The write is still scoped to the feed rather than trusting that read, so a
 * row deleted in between is a miss and not an insert.
 */
export async function updateEntryFromRequest(
  db: Database,
  slug: string,
  rawEntryId: string,
  body: unknown,
  now: Date = new Date()
): Promise<EntryRow> {
  const existing = await findEntryFromRequest(db, slug, rawEntryId);
  const updated = await updateEntry(
    db,
    existing.feed_id,
    existing.id,
    parseEntryUpdate(existing, body, now)
  );
  if (updated === undefined) {
    throw new EntryNotFoundError(rawEntryId);
  }
  return updated;
}

export { DuplicateGuidError, FeedNotFoundError };
