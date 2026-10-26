import { test } from "node:test";
import assert from "node:assert/strict";

import { compareVersions, fixedFor, rangesOf } from "./versions";

test("compareVersions: numbers, Go's v, and pre-releases before releases", () => {
  assert.ok(compareVersions("1.123.55", "1.45.0") > 0);
  assert.ok(compareVersions("v0.51.0", "0.52.0") < 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0", "1.0.0rc1") > 0);
  assert.ok(compareVersions("1.0.0.post1", "1.0.0") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("rangesOf: every introduced/fixed pair is its own stretch", () => {
  assert.deepEqual(
    rangesOf([
      { introduced: "0" },
      { fixed: "15.5.28" },
      { introduced: "16.0.0" },
      { fixed: "16.3.6" },
      { introduced: "17.0.0" },
      { last_affected: "17.0.2" },
    ]),
    [
      { introduced: "0", fixed: "15.5.28", lastAffected: null },
      { introduced: "16.0.0", fixed: "16.3.6", lastAffected: null },
      { introduced: "17.0.0", fixed: null, lastAffected: "17.0.2" },
    ],
  );
});

test("fixedFor: the fix on the installed version's own line", () => {
  const next = rangesOf([
    { introduced: "0" },
    { fixed: "15.5.28" },
    { introduced: "16.0.0" },
    { fixed: "16.3.6" },
  ]);
  assert.equal(
    fixedFor(next, "16.3.5"),
    "16.3.6",
    "never a downgrade to 15.5.28",
  );
  assert.equal(fixedFor(next, "15.0.0"), "15.5.28");
  const brace = rangesOf([
    { introduced: "0" },
    { fixed: "1.1.20" },
    { introduced: "2.0.0" },
    { fixed: "2.0.3" },
    { introduced: "5.0.0" },
    { fixed: "5.0.10" },
  ]);
  assert.equal(fixedFor(brace, "1.1.18"), "1.1.20");
  assert.equal(fixedFor(brace, "5.0.9"), "5.0.10");
  assert.equal(
    fixedFor(
      rangesOf([{ introduced: "1.0.0" }, { last_affected: "1.4.0" }]),
      "1.2.0",
    ),
    null,
    "no fix shipped for that line",
  );
  assert.equal(
    fixedFor(rangesOf([{ introduced: "0" }, { fixed: "2.0.0" }]), "3.1.0"),
    null,
    "outside every stretch and nothing above it",
  );
});
