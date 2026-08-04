import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TEMPLATE_DIRECTORY,
  PUBLIC_DIRECTORY,
  joinHtml,
  loadTemplate,
  render,
  renderTemplate,
  renderValue,
  safe,
  templateDirectoryExists,
} from "./template.js";

describe("renderTemplate", () => {
  it("substitutes a placeholder", () => {
    expect(renderTemplate("<p>{{name}}</p>", { name: "Ada" })).toBe("<p>Ada</p>");
  });

  it("escapes a plain string value", () => {
    expect(renderTemplate("<p>{{name}}</p>", { name: "<script>alert(1)</script>" })).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"
    );
  });

  it("escapes a value landing in an attribute", () => {
    expect(renderTemplate('<a title="{{t}}">x</a>', { t: `" onerror="alert(1)` })).toBe(
      '<a title="&quot; onerror=&quot;alert(1)">x</a>'
    );
  });

  it("writes a safe() value through untouched", () => {
    expect(renderTemplate("<ul>{{rows}}</ul>", { rows: safe("<li>one</li>") })).toBe(
      "<ul><li>one</li></ul>"
    );
  });

  it("renders a number", () => {
    expect(renderTemplate("<td>{{n}}</td>", { n: 42 })).toBe("<td>42</td>");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("{{ name }}", { name: "Ada" })).toBe("Ada");
  });

  it("replaces every occurrence", () => {
    expect(renderTemplate("{{a}}-{{a}}", { a: "x" })).toBe("x-x");
  });

  it("throws on a placeholder with no value rather than rendering it blank", () => {
    expect(() => renderTemplate("<p>{{missing}}</p>", {})).toThrow(/\{\{missing\}\}/);
  });

  it("does not re-scan substituted content for placeholders", () => {
    // A feed title containing {{rows}} must not be able to reach another value.
    expect(renderTemplate("{{a}}", { a: "{{b}}" })).toBe("{{b}}");
  });
});

describe("renderValue", () => {
  it("escapes strings and passes safe html through", () => {
    expect(renderValue("<b>")).toBe("&lt;b&gt;");
    expect(renderValue(safe("<b>"))).toBe("<b>");
  });
});

describe("joinHtml", () => {
  it("concatenates fragments without escaping them again", () => {
    expect(joinHtml([safe("<li>a</li>"), safe("<li>b</li>")], "").html).toBe(
      "<li>a</li><li>b</li>"
    );
  });

  it("returns an empty value for no fragments", () => {
    expect(joinHtml([]).html).toBe("");
  });
});

describe("template files", () => {
  it("resolves the views directory from the module, not the process cwd", () => {
    // src/lib/html and build/lib/html sit at the same depth, so this one path
    // has to land on the repo root under both tsx and node.
    expect(templateDirectoryExists()).toBe(true);
    expect(path.basename(TEMPLATE_DIRECTORY)).toBe("views");
  });

  it("resolves the public directory the same way", () => {
    expect(fs.existsSync(PUBLIC_DIRECTORY)).toBe(true);
  });

  it("ships the vendored htmx build that the page asks for", () => {
    expect(fs.existsSync(path.join(PUBLIC_DIRECTORY, "vendor", "htmx.min.js"))).toBe(true);
  });

  it("loads every template the code renders", () => {
    for (const name of [
      "index",
      "feed-row",
      "feed-rows-empty",
      "copy-rss-button",
      "copy-script",
      "head-icons",
      "entry-row",
      "entry-edit-form",
      "edit-button",
      "delete-button",
      "validation-errors",
      "validation-error-item",
      "errors-cleared",
    ]) {
      expect(loadTemplate(name).length).toBeGreaterThan(0);
    }
  });

  /*
   * A favicon link is only ever exercised by a browser quietly fetching it, so a
   * typo in a filename shows up as a missing icon and nothing else — no error, no
   * failing request anyone sees. These walk the markup rather than restating the
   * list, so renaming a file without renaming the reference fails here.
   */
  describe("the icon set", () => {
    const inPublic = (href: string): string => path.join(PUBLIC_DIRECTORY, href.replace(/^\//, ""));

    it("links only to files that are actually shipped", () => {
      const hrefs = [...loadTemplate("head-icons").matchAll(/href="([^"]+)"/g)].map(
        ([, href]) => href
      );
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(fs.existsSync(inPublic(href)), `${href} is linked but not in public/`).toBe(true);
      }
    });

    it("ships the icons the manifest names", () => {
      const manifest = JSON.parse(fs.readFileSync(inPublic("/site.webmanifest"), "utf8")) as {
        readonly icons: readonly { readonly src: string }[];
      };
      expect(manifest.icons.length).toBeGreaterThan(0);
      for (const icon of manifest.icons) {
        expect(fs.existsSync(inPublic(icon.src)), `${icon.src} is in the manifest only`).toBe(true);
      }
    });

    /* The same walk for the mark beside the heading, including its 2x source. */
    it("shows the home page mark from files that are actually shipped", () => {
      const index = loadTemplate("index");
      const sources = [
        ...[...index.matchAll(/src="(\/[^"]+)"/g)].map(([, src]) => src),
        ...[...index.matchAll(/srcset="([^"]+)"/g)].flatMap(([, srcset]) =>
          srcset.split(",").map((candidate) => candidate.trim().split(/\s+/)[0])
        ),
      ].filter((source) => !source.startsWith("/vendor/"));
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        expect(fs.existsSync(inPublic(source)), `${source} is shown but not in public/`).toBe(true);
      }
    });

    /* Requested from the root by browsers that were never told about it. */
    it("ships a root favicon.ico even though nothing links to it", () => {
      expect(fs.existsSync(inPublic("/favicon.ico"))).toBe(true);
      expect(loadTemplate("head-icons")).not.toContain('href="/favicon.ico"');
    });
  });

  it("names the views directory when a template is missing", () => {
    expect(() => loadTemplate("no-such-template")).toThrow(/views/);
  });

  it("renders a real template file", () => {
    expect(render("feed-rows-empty", {})).toContain("No feeds yet");
  });
});
