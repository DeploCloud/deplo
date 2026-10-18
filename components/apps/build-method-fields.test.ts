import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildMethodFields } from "./build-method-fields";

test("DeploPacks BETA stays beside every existing build method when selected", () => {
  const html = renderToStaticMarkup(
    createElement(BuildMethodFields, {
      method: "deplopack",
      settings: {},
      deplopackAvailable: true,
      onMethodChange() {},
      onSettingsChange() {},
    }),
  );
  for (const name of [
    "DeploPacks",
    "BETA",
    "Railpack",
    "Nixpacks",
    "Dockerfile",
    "Static",
  ])
    assert.ok(html.includes(name), name);
  assert.equal((html.match(/role="radio"/g) ?? []).length, 5);
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /disabled=""/);
});
