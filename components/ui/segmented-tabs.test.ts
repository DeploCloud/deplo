import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SegmentedTabsList, SegmentedTabsTrigger, Tabs } from "./tabs";

test("a segmented switch grows with its triggers on a phone instead of clipping them", () => {
  const html = renderToStaticMarkup(
    createElement(
      Tabs,
      { defaultValue: "a" },
      createElement(
        SegmentedTabsList,
        null,
        createElement(SegmentedTabsTrigger, { value: "a" }, "A"),
      ),
    ),
  );
  const list = html.match(
    /role="tablist"[^>]*class="([^"]+)"|class="([^"]+)"[^>]*role="tablist"/,
  );
  const cls = list?.[1] ?? list?.[2] ?? "";
  assert.match(cls, /\bmax-md:h-auto\b/);
  assert.doesNotMatch(cls, /\bmax-md:h-11\b/);
});
