import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The lint tooltip comes in two shapes: the gutter marker's IS the .cm-tooltip
 * element, the squiggle's is a section inside .cm-tooltip-hover. Requiring both
 * classes on one element styles only the first and leaves the other uncapped.
 */
test("the lint tooltip rules do not require .cm-tooltip", () => {
  const src = readFileSync("components/apps/editor-theme.ts", "utf8");
  assert.equal(src.includes(".cm-tooltip.cm-tooltip-lint"), false);
  assert.match(src, /"\.cm-tooltip-lint": \{[^}]*maxWidth/);
});
