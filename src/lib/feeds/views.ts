import { SafeHtml, joinHtml, render, safe } from "../html/template.js";
import { feedPath } from "./presenter.js";
import { FeedSummaryRow } from "./repository.js";
import { ValidationIssue } from "./service.js";

/**
 * Renders the feed listing and its fragments.
 *
 * Every value here reaches the page through `render`, which escapes strings and
 * passes through only what `safe()` wrapped. The `safe()` calls below all wrap
 * markup produced by these same functions, never a database or request value.
 */

/** One row of the feed table. */
export function renderFeedRow(row: FeedSummaryRow): SafeHtml {
  return safe(
    render("feed-row", {
      title: row.title,
      description: row.description,
      slug: row.slug,
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
  return render("index", { rows: renderFeedRows(rows) });
}

/** The error list swapped in when a submitted form fails validation. */
export function renderValidationErrors(issues: readonly ValidationIssue[]): string {
  const items = issues.map((issue) =>
    safe(render("validation-error-item", { field: issue.field, message: issue.message }))
  );
  return render("validation-errors", { items: joinHtml(items) });
}
