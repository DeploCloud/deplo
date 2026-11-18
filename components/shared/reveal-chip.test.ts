import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RevealChip } from "./reveal-chip";

const render = (props: Parameters<typeof RevealChip>[0]) =>
  renderToStaticMarkup(createElement(RevealChip, props));

test("a readable value carries a Copy button at the end of its field", () => {
  const html = render({
    value: "smtp.acme.com",
    onCopy: () => "smtp.acme.com",
  });
  assert.match(html, /aria-label="Copy"/);
  assert.ok(
    html.indexOf('aria-label="Reveal value"') <
      html.indexOf('aria-label="Copy"'),
  );
});

test("the Copy button is never nested inside the reveal button", () => {
  const html = render({
    value: "x",
    onCopy: () => "x",
    copyLabel: "Copy value",
  });
  const reveal = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
  assert.doesNotMatch(reveal, /Copy value/);
  assert.equal(html.match(/<button/g)?.length, 2);
});

test("a secret or a read-only field offers nothing to copy", () => {
  for (const html of [
    render({ locked: true, onCopy: () => "x" }),
    render({ readOnly: true, onCopy: () => "x" }),
  ]) {
    assert.doesNotMatch(html, /<button/);
  }
});

test("without onCopy the field stays a single reveal button", () => {
  const html = render({ value: "x" });
  assert.equal(html.match(/<button/g)?.length, 1);
  assert.doesNotMatch(html, /Copy/);
});
