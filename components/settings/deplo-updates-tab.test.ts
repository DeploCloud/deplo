import { test } from "node:test";
import assert from "node:assert/strict";

import { heroState } from "./deplo-updates-tab";
import type { FleetSummary } from "./fleet-agents";

const fleet = (over: Partial<FleetSummary> = {}): FleetSummary => ({
  expected: "0.5.0",
  minimum: "0.4.0",
  total: 2,
  behind: [],
  updating: false,
  pausedBy: null,
  ...over,
});
const info = (over = {}) => ({
  current: "0.4.0",
  latest: null,
  updateAvailable: false,
  publishedAt: null,
  canary: false,
  ...over,
});
const base = {
  version: "0.4.0",
  updating: null,
  stalled: false,
  manual: null,
  error: null,
};
const behind = (failed: boolean) => ({
  id: "s1",
  name: "edge-1",
  version: "0.4.0",
  reach: "usable" as const,
  update: failed
    ? {
        running: false,
        failed: true,
        gaveUp: false,
        attempts: 1,
        failure: "no_return",
        lastError: "did not come back",
        firstFailedAt: null,
        nextRetryAt: null,
      }
    : null,
});

test("one answer for the panel and the fleet: all current reads up to date", () => {
  const hero = heroState({ ...base, info: info(), fleet: fleet() });
  assert.deepEqual(hero, {
    tone: "ok",
    title: "Deplo is up to date",
    line: "You're on v0.4.0.",
  });
});

test("a new version outranks servers still catching up", () => {
  const hero = heroState({
    ...base,
    info: info({ latest: "v0.5.0", updateAvailable: true }),
    fleet: fleet({ behind: [behind(false)] }),
  });
  assert.equal(hero.title, "Deplo v0.5.0 is available");
});

test("a server behind is progress; a failed one needs attention", () => {
  const rolling = heroState({
    ...base,
    info: info(),
    fleet: fleet({ behind: [behind(false)] }),
  });
  assert.equal(rolling.tone, "busy");
  assert.equal(rolling.line, "1 of 2 servers are on the latest version.");
  const stuck = heroState({
    ...base,
    info: info(),
    fleet: fleet({ behind: [behind(true)] }),
  });
  assert.equal(stuck.title, "A server needs attention");
});

test("a stalled self-update names the log, whatever else is true", () => {
  const hero = heroState({
    ...base,
    stalled: true,
    updating: { version: "0.5.0", logPath: "/var/log/deplo-update.log" },
    info: info({ latest: "v0.5.0", updateAvailable: true }),
    fleet: fleet(),
  });
  assert.equal(hero.tone, "warn");
  assert.match(hero.line, /deplo-update\.log/);
});
