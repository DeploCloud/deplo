import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SearchTrigger } from "./palette-kbd";

test("the rail's search is a 40px icon cell, never the full box squeezed", () => {
  const rail = renderToStaticMarkup(
    createElement(SearchTrigger, { compact: true }),
  );
  assert.match(rail, /\bw-10\b/);
  assert.match(rail, /\bh-10\b/, "square: as tall as it is wide");
  assert.doesNotMatch(rail, /pl-8|pr-7/, "no padding wider than the rail");
  assert.doesNotMatch(rail, />Search</, "the label stays out");

  const open = renderToStaticMarkup(createElement(SearchTrigger));
  assert.match(open, /\bw-full\b/);
  assert.match(open, />Search</);
});
