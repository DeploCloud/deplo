import { test } from "node:test";
import { existsSync, globSync } from "node:fs";
import { dirname } from "node:path";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TeamLoading from "@/app/(dashboard)/[team]/loading";
import OverviewLoading from "@/app/(dashboard)/[team]/(overview)/loading";

const label = (C: ComponentType) =>
  /aria-label="([^"]+)"/.exec(renderToStaticMarkup(createElement(C)))?.[1];

// A fallback at the team level covers every page under it, so it must not be one page's skeleton.
test("pages without their own skeleton fall back to a neutral one", () => {
  assert.equal(label(TeamLoading), "Loading");
});

test("the Overview keeps its own skeleton, scoped to the Overview", () => {
  assert.equal(label(OverviewLoading), "Loading dashboard");
});

test("the Overview skeleton stops at six cards, whole rows of two or three", () => {
  const html = renderToStaticMarkup(createElement(OverviewLoading));
  // One commit box per app card.
  const cards = html.split("bg-surface p-3").length - 1;
  assert.equal(cards, 6);
});

// A settings page without its own skeleton would show none, or another page's.
test("every settings page has a skeleton of its own", () => {
  const SETTINGS = "app/(dashboard)/[team]/settings";
  const pages = globSync(
    "app/(dashboard)/[[]team]/settings/**/page.tsx",
  ).filter((page) => {
    const dirs = page
      .slice(SETTINGS.length + 1)
      .split("/")
      .slice(0, -1);
    const named = dirs.filter((d) => !d.startsWith("("));
    // `import` only redirects to Migrations; nested editors keep the page they came from.
    return named.length <= 1 && named[0] !== "import";
  });
  assert.ok(pages.length >= 14, "the settings pages are found");
  const covered = (page: string) => {
    for (let dir = dirname(page); dir !== SETTINGS; dir = dirname(dir))
      if (existsSync(`${dir}/loading.tsx`)) return true;
    return false;
  };
  assert.deepEqual(
    pages.filter((page) => !covered(page)),
    [],
  );
});
