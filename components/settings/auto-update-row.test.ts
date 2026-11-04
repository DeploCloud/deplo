import { test } from "node:test";
import assert from "node:assert/strict";

import { autoUpdateLine, type AutoUpdateStatus } from "./auto-update-row";

const NOW = new Date("2026-11-05T12:00:00Z");
const on: AutoUpdateStatus = {
  enabled: true,
  blockedBy: null,
  hour: 2,
  timezone: "Europe/Rome",
  timezoneSource: "server",
  installsAt: "2026-11-06T01:00:00.000Z",
  nextCheckAt: "2026-11-06T01:00:00.000Z",
  heldReason: null,
  postponedUntil: null,
  postponedBy: null,
  postponedTimes: 0,
};

test("the row says when the waiting version installs, on the window's clock", () => {
  assert.equal(
    autoUpdateLine(on, "v0.9.1", NOW),
    "v0.9.1 installs itself tomorrow at 02:00 (Europe/Rome).",
  );
  assert.equal(
    autoUpdateLine(
      { ...on, postponedBy: "Alice", postponedTimes: 3 },
      "v0.9.1",
      NOW,
    ),
    "v0.9.1 installs itself tomorrow at 02:00 (Europe/Rome). Postponed 3 times, last by Alice.",
  );
  assert.equal(
    autoUpdateLine(on, null, NOW),
    "Next check tomorrow at 02:00 (Europe/Rome).",
  );
});

test("a pause names its reason, never just 'off'", () => {
  assert.match(
    autoUpdateLine({ ...on, blockedBy: "canary" }, "v1", NOW),
    /Canary/,
  );
  assert.match(
    autoUpdateLine({ ...on, blockedBy: "provider" }, "v1", NOW),
    /manages/,
  );
  assert.match(
    autoUpdateLine({ ...on, blockedBy: "host" }, "v1", NOW),
    /can't update itself/,
  );
  assert.match(autoUpdateLine({ ...on, enabled: false }, "v1", NOW), /^Off\./);
  assert.equal(
    autoUpdateLine({ ...on, heldReason: "Read it." }, "v0.9.1", NOW),
    "v0.9.1 has to be installed by hand.",
  );
});
