import { SafeHtml, joinHtml, render, safe } from "../html/template.js";
import { isSafeHttpUrl } from "../html/url.js";
import { feedPagePath, feedPath } from "./presenter.js";
import { EntryRow, FeedRow, FeedSummaryRow } from "./repository.js";
import { ValidationIssue } from "./service.js";

/**
 * Renders the feed listing, the per-feed page and their fragments.
 *
 * Every value here reaches the page through `render`, which escapes strings and
 * passes through only what `safe()` wrapped. The `safe()` calls below all wrap
 * markup produced by these same functions, never a database or request value.
 */

/** The shared stylesheet, injected into each page rather than duplicated per template. */
function styles(): SafeHtml {
  return safe(render("styles", {}));
}

/** The source link every page carries, so a reader can check what is running. */
function footer(): SafeHtml {
  return safe(render("footer", {}));
}

/** The behaviour behind every copy button on a page, injected the same way the styles are. */
function copyScript(): SafeHtml {
  return safe(render("copy-script", {}));
}

/**
 * The RSS control: a button that copies the feed's address, not a link to it.
 *
 * Following a link to an XML document downloads it in most browsers, which is
 * never what the click meant — the address is the thing a reader wants, to
 * paste somewhere else. The button carries the path and the page script
 * resolves it against the current location when clicked, so the copied value
 * is absolute without the server having to know its own public host.
 *
 * `label` names the feed and so carries a stored title. It is not wrapped in
 * `safe()`: `aria-label` is a quoted attribute, and escaping is what that
 * position needs.
 */
function renderCopyRssButton(slug: string, title: string): SafeHtml {
  return safe(
    render("copy-rss-button", {
      feedUrl: feedPath(slug),
      label: `Copy the RSS address for ${title}`,
    })
  );
}

/**
 * A link, or inert text when the URL is not one a browser should follow.
 *
 * This repeats the check the service already ran on the way in, deliberately.
 * Validation stops a `javascript:` URL being stored through the API, but a row
 * can arrive by other means — a migration, a fixture, a direct INSERT — and a
 * stored URL that reaches an `href` is clickable XSS no matter how it got there.
 * Escaping cannot help: `javascript:alert(1)` has nothing in it to escape.
 */
export function renderLink(url: string, text: string): SafeHtml {
  if (!isSafeHttpUrl(url)) {
    return safe(render("link-unsafe", { text }));
  }
  return safe(render("link", { href: url, text }));
}

/**
 * The trash button that deletes one thing and swaps the refreshed list in.
 *
 * `label` and `confirm` both name the thing being deleted, so both carry a
 * stored title. Neither is wrapped in `safe()`: `aria-label` is a quoted
 * attribute and `hx-confirm` is read as text by the browser's own dialog, so
 * escaping is exactly what each position needs.
 */
function renderDeleteButton(
  path: string,
  target: string,
  label: string,
  confirm: string
): SafeHtml {
  return safe(render("delete-button", { path, target, label, confirm }));
}

/**
 * The pencil button that swaps one row into its edit form.
 *
 * `label` names the entry and so carries a stored title. As with the trash
 * button it is not wrapped in `safe()`: `aria-label` is a quoted attribute, and
 * escaping is what that position needs.
 */
function renderEditButton(path: string, label: string): SafeHtml {
  return safe(render("edit-button", { path, label }));
}

/** One row of the feed table. */
export function renderFeedRow(row: FeedSummaryRow): SafeHtml {
  return safe(
    render("feed-row", {
      title: row.title,
      description: row.description,
      slug: row.slug,
      pagePath: feedPagePath(row.slug),
      rssButton: renderCopyRssButton(row.slug, row.title),
      entryCount: row.entry_count,
      // Deleting a feed takes its entries with it, which is not obvious from a
      // trash can on a row, so the confirmation says so before it happens.
      deleteButton: renderDeleteButton(
        feedPagePath(row.slug),
        "#feed-rows",
        `Delete the feed ${row.title}`,
        `Delete the feed "${row.title}"? This also deletes its entries.`
      ),
    })
  );
}

/** The table body: every row, or a placeholder when there are none. */
export function renderFeedRows(rows: readonly FeedSummaryRow[]): SafeHtml {
  if (rows.length === 0) {
    return safe(render("feed-rows-empty", {}));
  }
  return joinHtml(rows.map(renderFeedRow));
}

/** The whole listing page. */
export function renderIndexPage(rows: readonly FeedSummaryRow[]): string {
  return render("index", {
    rows: renderFeedRows(rows),
    styles: styles(),
    copyScript: copyScript(),
    footer: footer(),
  });
}

/**
 * Formats a stored timestamp for display, falling back to a dash.
 *
 * An unparseable value is shown as absent rather than as `Invalid Date`, which
 * is the same call the RSS mapper makes about the same column.
 */
export function formatPublishedAt(value: string | null): string {
  if (value === null) {
    return "—";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "—";
  }
  return parsed
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

/**
 * One entry.
 *
 * `description` and `content` routinely carry markup from real feeds, so they
 * are rendered as text: `render` escapes them, and neither is wrapped in
 * `safe()`. They still go out as CDATA in the RSS, which is correct there and
 * unaffected by this.
 *
 * The feed's slug is a parameter because an entry knows its `feed_id` and not
 * the name that feed is addressed by, and the delete button needs an address.
 */
export function renderEntryRow(slug: string, row: EntryRow): SafeHtml {
  const body = row.description ?? row.content ?? "";
  const path = entryPath(slug, row);
  return safe(
    render("entry-row", {
      titleLink: renderLink(row.url, row.title),
      publishedAt: formatPublishedAt(row.published_at),
      author: row.author === null ? "" : ` · ${row.author}`,
      description: body,
      editButton: renderEditButton(`${path}/edit`, `Edit the entry ${row.title}`),
      deleteButton: renderDeleteButton(
        path,
        "#entry-list",
        `Delete the entry ${row.title}`,
        `Delete the entry "${row.title}"?`
      ),
    })
  );
}

/** Where one entry is edited, deleted and read back from. */
function entryPath(slug: string, row: EntryRow): string {
  return `${feedPagePath(slug)}/entries/${String(row.id)}`;
}

/**
 * The row rewritten as the form that edits it.
 *
 * Every field is a stored value landing in a quoted `value` attribute, and none
 * of them is wrapped in `safe()` — a title carrying a quote has to escape here
 * exactly as it does in the row it replaces.
 *
 * The published date is shown as text rather than filled into the input. A
 * `datetime-local` value has no timezone, so prefilling it with the stored UTC
 * instant would have the browser read it back as a local one and shift the
 * entry by the reader's offset on every save; the service reads a blank date as
 * "leave it alone" for the same reason.
 */
export function renderEntryEditForm(slug: string, row: EntryRow): SafeHtml {
  const path = entryPath(slug, row);
  return safe(
    render("entry-edit-form", {
      path,
      cancelPath: path,
      url: row.url,
      title: row.title,
      description: row.description ?? "",
      publishedAt: formatPublishedAt(row.published_at),
    })
  );
}

/** The entry list, or an empty state that says how to add the first one. */
export function renderEntryRows(slug: string, rows: readonly EntryRow[]): SafeHtml {
  if (rows.length === 0) {
    return safe(render("entries-empty", { slug }));
  }
  return joinHtml(rows.map((row) => renderEntryRow(slug, row)));
}

/** The feed's own site link, omitted entirely when it has none. */
function renderSiteLink(feed: FeedRow): SafeHtml {
  if (feed.link === null || feed.link.trim().length === 0) {
    return safe("");
  }
  return safe(render("feed-site-link", { link: renderLink(feed.link, "Site") }));
}

/** The browsable page for one feed. */
export function renderFeedPage(feed: FeedRow, entries: readonly EntryRow[]): string {
  return render("feed", {
    title: feed.title,
    description: feed.description,
    slug: feed.slug,
    feedUrl: feedPath(feed.slug),
    rssButton: renderCopyRssButton(feed.slug, feed.title),
    createPath: `${feedPagePath(feed.slug)}/entries`,
    entryCount: entries.length,
    siteLink: renderSiteLink(feed),
    entries: renderEntryRows(feed.slug, entries),
    styles: styles(),
    copyScript: copyScript(),
    footer: footer(),
  });
}

/** The 404 page. */
export function renderNotFoundPage(message: string): string {
  return render("not-found", { message, styles: styles(), footer: footer() });
}

/** The error list swapped in when a submitted form fails validation. */
export function renderValidationErrors(issues: readonly ValidationIssue[]): string {
  const items = issues.map((issue) =>
    safe(render("validation-error-item", { field: issue.field, message: issue.message }))
  );
  return render("validation-errors", { items: joinHtml(items) });
}
