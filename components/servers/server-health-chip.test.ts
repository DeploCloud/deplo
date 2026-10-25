import { test } from "node:test";
import assert from "node:assert/strict";

import { healthTip } from "@/app/(dashboard)/[team]/settings/servers/server-health-chip";
import { HEALTH_MESSAGES } from "@/lib/infra/server-health";

test("an offline server that links in is told to check the machine, and nothing about ports", () => {
  const tip = healthTip({
    status: "offline",
    message: HEALTH_MESSAGES.linkDown,
    checkedAt: new Date().toISOString(),
    traefikEnabled: true,
    lastReachedAt: null,
  });
  assert.ok(tip.startsWith(HEALTH_MESSAGES.linkDown), tip);
  assert.doesNotMatch(tip, /9443|port|firewall/i);
});

test("an offline server Deplo still dials is told the same, and nothing about ports", () => {
  for (const message of [HEALTH_MESSAGES.refused, HEALTH_MESSAGES.timedOut]) {
    const tip = healthTip({
      status: "offline",
      message,
      checkedAt: new Date().toISOString(),
      traefikEnabled: true,
      lastReachedAt: null,
    });
    assert.ok(tip.includes(HEALTH_MESSAGES.linkDown), tip);
    assert.doesNotMatch(tip, /9443|firewall|inbound|outbound/i);
  }
});
