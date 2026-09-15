import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanToolVersion } from "./app-graph-rows/build";

test("a build tool version is x.y.z, latest, or nothing", () => {
  assert.equal(cleanToolVersion("1.2.3"), "1.2.3");
  assert.equal(cleanToolVersion(" v0.35.0 "), "0.35.0");
  assert.equal(cleanToolVersion("Latest"), "latest");
  assert.equal(cleanToolVersion(""), null);
  assert.equal(cleanToolVersion(undefined), null);
  for (const bad of [
    "1/../../../../attacker/repo/releases/download/evil/rp",
    "1.2.3/x",
    "..",
    "1.2",
    "1.2.3-rc1",
    "latest/../x",
  ])
    assert.throws(() => cleanToolVersion(bad), /Use a version like/, bad);
});
