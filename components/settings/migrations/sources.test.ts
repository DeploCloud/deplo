import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

import { MigrationGraphic } from "./migration-graphic";
import { copyFor, SOURCE_ART, SOURCE_COPY } from "./sources";

/**
 * The marks and the words. Only what the type checker cannot already prove.
 */

const html = (props: Parameters<typeof MigrationGraphic>[0]) =>
  renderToStaticMarkup(React.createElement(MigrationGraphic, props));

test("every mark is real path data, not a bad paste", () => {
  for (const [kind, art] of Object.entries(SOURCE_ART)) {
    assert.ok(art.paths.length > 0, kind);
    assert.ok(art.viewBox.split(/\s+/).length === 4, kind);
    for (const p of art.paths)
      assert.match(p.d, /^M/, `${kind}: ${p.d.slice(0, 12)}`);
  }
});

// The bug this feature can actually ship: defaulting the unknown state to a
// product, so the first screen tells everybody they are migrating from one.
test("before the scan, nothing is named a product", () => {
  const unknown = copyFor(null).name;
  assert.notEqual(unknown, "Dokploy");
  assert.notEqual(unknown, "Coolify");
  assert.equal(copyFor("coolify").name, "Coolify");
  assert.equal(copyFor("dokploy").name, "Dokploy");
  // Both platforms are offered by name where the words have to say which.
  assert.match(SOURCE_COPY.unknown.tokenInfo, /Dokploy/);
  assert.match(SOURCE_COPY.unknown.tokenInfo, /Coolify/);
});

test("the illustration draws no mark until it knows which panel it is", () => {
  const blank = html({ state: "connect" });
  assert.doesNotMatch(blank, /#8c52ff/);
  assert.equal(blank.includes(SOURCE_ART.dokploy.paths[0].d), false);
  assert.match(blank, /An unidentified server/);
});

test("the mark that lands is the one the scan found", () => {
  const coolify = html({ state: "install", kind: "coolify" });
  assert.match(coolify, /#8c52ff/);
  assert.ok(coolify.includes(SOURCE_ART.coolify.paths[0].d));
  assert.equal(coolify.includes(SOURCE_ART.dokploy.paths[0].d), false);
  assert.match(coolify, /from the Coolify server toward Deplo/);

  const dokploy = html({ state: "install", kind: "dokploy" });
  assert.ok(dokploy.includes(SOURCE_ART.dokploy.paths[0].d));
  assert.doesNotMatch(dokploy, /#8c52ff/);
});

// `done` is the pose where the source stops being the subject. `--border` is the
// token for that, and it has nothing below it to tint with.
test("a switched-off mark drops its brand colour and its layering", () => {
  const done = html({ state: "done", kind: "coolify" });
  assert.doesNotMatch(done, /#8c52ff/);
  assert.doesNotMatch(done, /fill-opacity/);
  assert.match(done, /text-border/);
  assert.ok(done.includes(SOURCE_ART.coolify.paths[0].d));
});
