import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TeamLoading from "@/app/(dashboard)/[team]/loading";
import SettingsLoading from "@/app/(dashboard)/[team]/settings/loading";
import OverviewLoading from "@/app/(dashboard)/[team]/(overview)/loading";

const label = (C: ComponentType) =>
  /aria-label="([^"]+)"/.exec(renderToStaticMarkup(createElement(C)))?.[1];

// A fallback at the team level covers every page under it, so it must not be one page's skeleton.
test("pages without their own skeleton fall back to a neutral one", () => {
  assert.equal(label(TeamLoading), "Loading");
  assert.equal(label(SettingsLoading), "Loading");
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
