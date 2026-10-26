import { test } from "node:test";
import assert from "node:assert/strict";

import { epssLabel, fixLine } from "./fix-line";

test("fixLine: one plain line per way of getting the fix", () => {
  const base = {
    packageName: "minimist",
    fixedVersion: "1.2.6",
    newerTag: null,
    flaws: 1,
  };
  assert.equal(
    fixLine({ ...base, fix: "code" }),
    "Update minimist to 1.2.6 in your code",
  );
  assert.equal(
    fixLine({ ...base, fix: "update", flaws: 3 }),
    "A newer build of this image fixes 3 known flaws: update to get it",
  );
  assert.equal(
    fixLine({ ...base, fix: "newer_tag", newerTag: "1.60.2" }),
    "Version 1.60.2 is available and fixes 1 known flaw",
  );
  assert.equal(
    fixLine({ ...base, fix: "upstream", flaws: 2 }),
    "The newer build still has them: waiting on the image's maintainers",
  );
  assert.equal(
    fixLine({ ...base, fix: "unverified" }),
    "A newer build is out: Deplo is checking whether it fixes 1 known flaw",
  );
  assert.equal(fixLine({ ...base, fix: "deplo" }), "", "never shown");
});

test("epssLabel: a percentage, and <1% rather than a misleading 0%", () => {
  assert.equal(epssLabel(0.1234), "EPSS 12%");
  assert.equal(epssLabel(0.004), "EPSS <1%");
  assert.equal(epssLabel(null), null);
});
