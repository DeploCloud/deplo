import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The gutter tooltip IS .cm-tooltip, the squiggle's is a section inside .cm-tooltip-hover: requiring both classes left one uncapped.
test("the lint tooltip rules do not require .cm-tooltip", () => {
  const src = readFileSync("components/apps/editor-theme.ts", "utf8");
  assert.equal(src.includes(".cm-tooltip.cm-tooltip-lint"), false);
  assert.match(src, /"\.cm-tooltip-lint": \{[^}]*maxWidth/);
});
