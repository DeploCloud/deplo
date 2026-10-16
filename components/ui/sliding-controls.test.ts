import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WindowSelector,
  WINDOWS,
} from "@/components/monitoring/dashboard-parts";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  SegmentedTabsList,
  SegmentedTabsTrigger,
} from "./tabs";

test("every chart window remains selectable with exactly one pressed option", () => {
  for (const selected of WINDOWS) {
    const html = renderToStaticMarkup(
      createElement(WindowSelector, {
        windowMs: selected.ms,
        onChange() {},
      }),
    );
    const weights = [...html.matchAll(/<button[^>]*class="([^"]*)"/g)].map(
      ([, classes]) =>
        classes.match(/\bfont-(?:normal|medium|semibold|bold)\b/g)?.join(" ") ??
        "inherited",
    );
    assert.equal(
      new Set(weights).size,
      1,
      "Selected and inactive options keep the same weight",
    );
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.match(
      html,
      new RegExp(`aria-pressed="true"[^>]*>Last ${selected.label}<`),
    );
    for (const window of WINDOWS)
      assert.ok(html.includes(`Last ${window.label}`));
  }
});

for (const segmented of [false, true]) {
  test(`${segmented ? "segmented" : "standard"} tabs preserve selection and disabled options`, () => {
    const List = segmented ? SegmentedTabsList : TabsList;
    const Trigger = segmented ? SegmentedTabsTrigger : TabsTrigger;
    const html = renderToStaticMarkup(
      createElement(
        Tabs,
        { defaultValue: "one" },
        createElement(
          List,
          null,
          createElement(Trigger, { value: "one" }, "First"),
          createElement(Trigger, { value: "two", disabled: true }, "Second"),
        ),
      ),
    );
    assert.match(html, /data-state="active"[^>]*>First</);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Second</);
    assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
  });
}
