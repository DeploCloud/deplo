import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SearchTrigger } from "./palette-kbd";

const buttonClass = (html: string) =>
  html.match(/^<button[^>]*class="([^"]+)"/)?.[1];

test("the rail's search is the same 40px-tall box, only its label fades", () => {
  const rail = renderToStaticMarkup(
    createElement(SearchTrigger, { compact: true }),
  );
  const open = renderToStaticMarkup(createElement(SearchTrigger));
  assert.equal(buttonClass(rail), buttonClass(open), "one box, so it morphs");
  assert.match(
    buttonClass(open) ?? "",
    /\bh-10\b.*\bw-full\b|\bw-full\b.*\bh-10\b/,
  );
  assert.match(rail, /class="[^"]*opacity-0[^"]*">Search</);
  assert.doesNotMatch(open, /opacity-0/);
});
