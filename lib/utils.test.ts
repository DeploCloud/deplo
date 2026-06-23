import { test } from "node:test";
import assert from "node:assert/strict";
import { isHexColor, normalizeHexColor, readableTextColor } from "./utils";
import { FOLDER_COLORS } from "./folder-colors";

test("isHexColor accepts 3/6-digit hex (with or without #, any case), rejects junk", () => {
  for (const ok of ["#fff", "fff", "#3b82f6", "3B82F6", "  #abc  "]) {
    assert.equal(isHexColor(ok), true, `expected ${ok} to be valid`);
  }
  for (const bad of ["", "#ff", "#fffff", "#1234567", "#gggggg", "blue"]) {
    assert.equal(isHexColor(bad), false, `expected ${bad} to be invalid`);
  }
});

test("normalizeHexColor canonicalises to lowercase #rrggbb and expands shorthand", () => {
  assert.equal(normalizeHexColor("#FFF"), "#ffffff");
  assert.equal(normalizeHexColor("abc"), "#aabbcc");
  assert.equal(normalizeHexColor("  #3B82F6 "), "#3b82f6");
  assert.throws(() => normalizeHexColor("#12"), /valid hex/);
  assert.throws(() => normalizeHexColor("nope"), /valid hex/);
});

test("readableTextColor picks the higher-contrast foreground (auto-contrast)", () => {
  // Light backgrounds → dark text; dark backgrounds → light text.
  assert.equal(readableTextColor("#ffffff"), "#000000");
  assert.equal(readableTextColor("#000000"), "#ffffff");
  assert.equal(readableTextColor("#facc15"), "#000000"); // light yellow
  assert.equal(readableTextColor("#f59e0b"), "#000000"); // amber
  assert.equal(readableTextColor("#1e1b4b"), "#ffffff"); // near-black navy
  // Shorthand and a missing # are tolerated.
  assert.equal(readableTextColor("fff"), "#000000");
  assert.equal(readableTextColor("#000"), "#ffffff");
  // An unparseable value falls back to a safe dark foreground (never throws).
  assert.equal(readableTextColor("nope"), "#000000");
});

test("readableTextColor returns a valid foreground for every curated folder colour", () => {
  for (const c of FOLDER_COLORS) {
    const fg = readableTextColor(c.value);
    assert.ok(
      fg === "#000000" || fg === "#ffffff",
      `${c.name} (${c.value}) → ${fg}`,
    );
  }
});
