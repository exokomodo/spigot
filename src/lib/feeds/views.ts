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

/** One row of the feed table. */
export function renderFeedRow(row: FeedSummaryRow): SafeHtml {
  return safe(
    render("feed-row", {
      title: row.title,
      description: row.description,
      slug: row.slug,
      pagePath: feedPagePath(row.slug),
      feedUrl: feedPath(row.slug),
      entryCount: row.entry_count,
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
  return render("index", { rows: renderFeedRows(rows), styles: styles(), footer: footer() });
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
 */
export function renderEntryRow(row: EntryRow): SafeHtml {
  const body = row.description ?? row.content ?? "";
  return safe(
    render("entry-row", {
      titleLink: renderLink(row.url, row.title),
      publishedAt: formatPublishedAt(row.published_at),
      author: row.author === null ? "" : ` · ${row.author}`,
      description: body,
    })
  );
}

/** The entry list, or an empty state that says how to add the first one. */
export function renderEntryRows(slug: string, rows: readonly EntryRow[]): SafeHtml {
  if (rows.length === 0) {
    return safe(render("entries-empty", { slug }));
  }
  return joinHtml(rows.map(renderEntryRow));
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
    createPath: `${feedPagePath(feed.slug)}/entries`,
    entryCount: entries.length,
    siteLink: renderSiteLink(feed),
    entries: renderEntryRows(feed.slug, entries),
    styles: styles(),
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
