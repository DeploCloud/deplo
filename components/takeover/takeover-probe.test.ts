import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Until the ports move, the old panel answers the dashboard's own https address
 * with a 404. An opaque `no-cors` probe resolves on that 404 exactly as it does
 * on Deplo, which is how the wizard sent the operator to a dead page - away from
 * the Try again button, which lives on the page it left.
 */

const read = (p: string) => readFile(join(process.cwd(), p), "utf8");

test("the takeover probe reads the answer, it does not just connect", async () => {
  const step = await read("components/takeover/takeover-actions.tsx");
  const probe = step.slice(step.indexOf("/api/health"));
  assert.ok(!probe.includes(`"no-cors"`), "an opaque answer proves nothing");
  assert.match(probe, /\.then\(\(r\) => r\.ok\)/);
});

test("health answers the probe cross-origin", async () => {
  const route = await read("app/api/health/route.ts");
  assert.match(route, /"access-control-allow-origin": "\*"/);
});
