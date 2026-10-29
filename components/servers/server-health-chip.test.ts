import { test } from "node:test";
import assert from "node:assert/strict";

import { healthTip } from "@/app/(dashboard)/[team]/settings/servers/server-health-chip";
import { HEALTH_MESSAGES } from "@/lib/infra/server-health";

test("an offline server that links in is told to check the machine, and nothing about ports", () => {
  const tip = healthTip({
    status: "offline",
    message: HEALTH_MESSAGES.offline,
    checkedAt: new Date().toISOString(),
    traefikEnabled: true,
    lastReachedAt: null,
  });
  assert.ok(tip.startsWith(HEALTH_MESSAGES.offline), tip);
  assert.doesNotMatch(tip, /9443|port|firewall/i);
});

test("an offline server's tip is only what to check, whatever an older check stored", () => {
  for (const message of [
    "The agent did not answer (connection refused). Is it running on the host?",
    "The agent did not answer within the health-check deadline.",
    null,
  ]) {
    const tip = healthTip({
      status: "offline",
      message,
      checkedAt: new Date().toISOString(),
      traefikEnabled: true,
      lastReachedAt: null,
    });
    assert.equal(tip.split(" · ")[0], HEALTH_MESSAGES.offline, tip);
    assert.doesNotMatch(tip, /did not answer|refused|9443|firewall/i);
  }
});
