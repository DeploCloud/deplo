import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TeamLoading from "@/app/(dashboard)/[team]/loading";

// A loading state shows the page's real header, so its strings must be the page's own.
const ROOT = path.join(import.meta.dirname, "..", "app");
const HEADER = /<PageHeader\b([^>]*?)\/?>/g;
const STRING_PROP = /\b(title|description|docs)="([^"]*)"/g;

function headerStrings(source: string): string[] {
  const out: string[] = [];
  for (const [, props] of source.matchAll(HEADER))
    for (const [, name, value] of props.matchAll(STRING_PROP))
      out.push(`${name}="${value}"`);
  return out;
}

describe("route loading states", () => {
  const loadings = globSync("**/loading.tsx", { cwd: ROOT });
  const allPages = globSync("**/page.tsx", { cwd: ROOT });

  it("finds the loading states", () => {
    assert.ok(loadings.length > 20, `found ${loadings.length}`);
  });

  for (const file of loadings) {
    const strings = headerStrings(readFileSync(path.join(ROOT, file), "utf8"));
    if (strings.length === 0) continue;
    it(`${file} shows a header one of its pages renders`, () => {
      const dir = path.dirname(file);
      const pages = allPages
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => readFileSync(path.join(ROOT, p), "utf8"));
      for (const s of strings)
        assert.ok(
          pages.some((p) => p.includes(s)),
          `${s} is in ${file} but in none of its pages`,
        );
    });
  }

  // It covers every page under the team, so a shape here would belong to none of them.
  it("the team-level fallback draws no page's shape", () => {
    const html = renderToStaticMarkup(createElement(TeamLoading));
    assert.match(html, /aria-busy/);
    assert.doesNotMatch(html, /data-slot="skeleton"/);
  });

  it("the Overview skeleton stops at six cards, whole rows of two or three", () => {
    const src = readFileSync(
      path.join(ROOT, "(dashboard)/[team]/(overview)/loading.tsx"),
      "utf8",
    );
    assert.match(src, /<AppCardSkeleton\b/);
    assert.match(src, /length: 6 \}/);
  });

  // A settings page without its own loading state would show none, or another page's.
  it("every settings page has a loading state of its own", () => {
    const SETTINGS = "(dashboard)/[team]/settings";
    const pages = allPages.filter((page) => {
      if (!page.startsWith(`${SETTINGS}/`)) return false;
      const named = page
        .slice(SETTINGS.length + 1)
        .split("/")
        .slice(0, -1)
        .filter((d) => !d.startsWith("("));
      // These only redirect; nested editors keep the page they came from.
      const redirects = ["import", "licenses", "mcp", "dns"];
      return named.length <= 1 && !redirects.includes(named[0]);
    });
    assert.ok(pages.length >= 14, "the settings pages are found");
    const covered = (page: string) => {
      for (
        let dir = path.dirname(page);
        dir !== SETTINGS;
        dir = path.dirname(dir)
      )
        if (existsSync(path.join(ROOT, dir, "loading.tsx"))) return true;
      return false;
    };
    assert.deepEqual(
      pages.filter((page) => !covered(page)),
      [],
    );
  });
});
