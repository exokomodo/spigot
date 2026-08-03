import fs from "node:fs";
import path from "node:path";
import { escapeHtml } from "./escape.js";

/**
 * Templates are plain `.html` files under `views/`, interpolated with
 * `{{placeholder}}`.
 *
 * Escaping is the default and rawness is opt-in: a plain string value is
 * escaped, and only a value explicitly wrapped in `safe()` is written through
 * untouched. Forgetting to escape is therefore not something a caller can do by
 * omission — it takes writing `safe()`, which is greppable.
 */

/** Markup that is already escaped, or was generated rather than supplied. */
export interface SafeHtml {
  readonly html: string;
}

export type TemplateValue = string | number | SafeHtml;

/**
 * Marks a string as ready to embed without escaping. Only ever call this on
 * markup this code produced — never on anything that came from a request or
 * the database.
 */
export function safe(html: string): SafeHtml {
  return { html };
}

export function isSafeHtml(value: TemplateValue): value is SafeHtml {
  return typeof value === "object";
}

/** Renders a value for embedding: `safe()` passes through, everything else is escaped. */
export function renderValue(value: TemplateValue): string {
  if (isSafeHtml(value)) {
    return value.html;
  }
  return escapeHtml(String(value));
}

/** Joins already-rendered fragments into one safe value. */
export function joinHtml(fragments: readonly SafeHtml[], separator = "\n"): SafeHtml {
  return safe(fragments.map((fragment) => fragment.html).join(separator));
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Substitutes `{{name}}` placeholders.
 *
 * A placeholder with no matching value throws rather than rendering an empty
 * string or leaving the raw `{{name}}` on the page — a typo in a template is a
 * bug, and both silent alternatives hide it.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, TemplateValue>>
): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`Template placeholder "{{${name}}}" has no value`);
    }
    return renderValue(values[name]);
  });
}

/**
 * Repo root, resolved from this module rather than the process working
 * directory, which differs between `npm start` and a systemd unit.
 *
 * `src/lib/html/` and `build/lib/html/` sit at the same depth, so one relative
 * path lands on the root under both `tsx src/main.ts` and `node build/main.js`.
 * `templateDirectoryExists()` exists so a future move of this file fails a test
 * loudly instead of at runtime on the deployed host.
 */
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export const TEMPLATE_DIRECTORY = path.join(PROJECT_ROOT, "views");

/** Static assets served as-is, such as the vendored HTMX build. */
export const PUBLIC_DIRECTORY = path.join(PROJECT_ROOT, "public");

export function templateDirectoryExists(): boolean {
  return fs.existsSync(TEMPLATE_DIRECTORY);
}

const cache = new Map<string, string>();

/**
 * Reads `views/<name>.html`, caching it after the first read.
 *
 * A missing template names the directory it looked in, since the likeliest
 * cause is a deploy that shipped the build output without the templates.
 */
export function loadTemplate(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const file = path.join(TEMPLATE_DIRECTORY, `${name}.html`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Template "${name}" not found at ${file}. ` +
        `Templates live in ${TEMPLATE_DIRECTORY}; check that views/ was deployed alongside build/.`
    );
  }
  const contents = fs.readFileSync(file, "utf8");
  cache.set(name, contents);
  return contents;
}

/** Loads a template and interpolates it in one call. */
export function render(name: string, values: Readonly<Record<string, TemplateValue>>): string {
  return renderTemplate(loadTemplate(name), values);
}

/** Drops the template cache. Only needed by tests that rewrite template files. */
export function clearTemplateCache(): void {
  cache.clear();
}
