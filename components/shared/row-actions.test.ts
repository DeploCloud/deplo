import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Pencil, Trash2 } from "lucide-react";

import { RowActions } from "./row-actions";

const edit = { label: "Edit", icon: Pencil, onSelect: () => {} };
const del = { label: "Delete", icon: Trash2, destructive: true };
const render = (actions: Parameters<typeof RowActions>[0]["actions"]) =>
  renderToStaticMarkup(
    createElement(RowActions, {
      title: "API_KEY",
      actions,
      children: "INLINE",
    }),
  );

test("a row with one action keeps its button, on a phone too", () => {
  const html = render([edit, false]);
  assert.equal(html, "INLINE");
});

test("two or more actions fold into one kebab below md, the buttons stay above it", () => {
  const html = render([edit, del]);
  assert.match(html, /class="contents max-md:hidden">INLINE</);
  assert.match(
    html,
    /md:hidden[^"]*"><button[^>]*aria-label="Actions for API_KEY"/,
  );
});
