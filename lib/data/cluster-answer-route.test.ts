import { test } from "node:test";
import assert from "node:assert/strict";

import { routeAfterAnswers } from "./clusters/forwarders";

// c39: a new domain answered 404 on every server for 15 s, its route waiting for every proxy's certificates.
test("a domain switched on is routed once every table is handed, before the proxies and certificates", async () => {
  const steps: string[] = [];
  await routeAfterAnswers("clu_1", "shop", {
    sync: async (id) => void steps.push(`tables ${id}`),
    settle: async (id, app) => void steps.push(`checks ${id} ${app}`),
    reroute: async (id) => void steps.push(`reroute ${id}`),
    tail: async (id) => void steps.push(`certificates ${id}`),
  });
  assert.deepEqual(steps, [
    "tables clu_1",
    // c40: the way its certificate is checked before its first route, or the zone's pass routed it again.
    "checks clu_1 shop",
    "reroute shop",
    "certificates clu_1",
  ]);
});
