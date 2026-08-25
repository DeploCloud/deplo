import { test } from "node:test";
import assert from "node:assert/strict";

import { TOKEN_PRESETS, presetIdFor, tokenPreset } from "./token-presets";
import { CAPABILITY_META } from "./capabilities";
import { ALL_CAPABILITIES } from "./types";

test("every template is a well-formed capability set", () => {
  for (const p of TOKEN_PRESETS) {
    assert.ok(
      p.capabilities.includes("view"),
      `${p.id} is missing the view floor`,
    );
    assert.equal(
      new Set(p.capabilities).size,
      p.capabilities.length,
      `${p.id} repeats a capability`,
    );
    // Also catches a name that isn't in the catalog at all: filtering
    // ALL_CAPABILITIES can only ever produce known names, in canonical order.
    assert.deepEqual(
      p.capabilities,
      ALL_CAPABILITIES.filter((c) => p.capabilities.includes(c)),
      `${p.id} is not in catalog order`,
    );
  }
});

/**
 * The assertion with teeth.
 */
test("only Root access hands out a sensitive capability, and it hands out everything", () => {
  const root = TOKEN_PRESETS.find((p) => p.id === "root");
  assert.ok(root);
  assert.deepEqual(root.capabilities, ALL_CAPABILITIES);

  for (const p of TOKEN_PRESETS.filter((p) => p.id !== "root")) {
    assert.deepEqual(
      p.capabilities.filter((c) => CAPABILITY_META[c].sensitive),
      [],
      `${p.id} would hand out a sensitive permission by default`,
    );
  }
});

test("ids and capability sets are unique, so presetIdFor can't lie", () => {
  assert.equal(
    new Set(TOKEN_PRESETS.map((p) => p.id)).size,
    TOKEN_PRESETS.length,
  );
  const sets = TOKEN_PRESETS.map((p) => p.capabilities.join(","));
  assert.equal(
    new Set(sets).size,
    sets.length,
    "two templates grant exactly the same thing",
  );
});

test("every template carries copy, and none of it uses an ellipsis", () => {
  for (const p of TOKEN_PRESETS) {
    assert.ok(p.name.length > 0, `${p.id} has no name`);
    assert.ok(p.description.length > 0, `${p.id} has no description`);
    assert.ok(
      !`${p.name} ${p.description}`.includes("…"),
      `${p.id} uses an ellipsis character`,
    );
  }
});

test("presetIdFor matches a set exactly, order-independently, and nothing else", () => {
  assert.equal(presetIdFor(["view", "view_logs"]), null);
  assert.equal(presetIdFor([...ALL_CAPABILITIES]), "root");
  assert.equal(presetIdFor(["view_logs", "deploy_apps", "view"]), "ci");
  assert.equal(presetIdFor([]), null);
});

test("tokenPreset resolves a known id and refuses an unknown one", () => {
  assert.equal(tokenPreset("mcp")?.name, "MCP & AI agents");
  assert.equal(tokenPreset("nope"), null);
});
