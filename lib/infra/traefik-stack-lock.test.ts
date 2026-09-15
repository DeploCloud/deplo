import { test } from "node:test";
import assert from "node:assert/strict";

import { withTraefikStackLock } from "./agent-client/host-ops";

test("two writers on ONE server never interleave their read and their write", async () => {
  const order: string[] = [];
  const rmw = (who: string) => async () => {
    order.push(`${who}:read`);
    await new Promise((r) => setTimeout(r, 10));
    order.push(`${who}:write`);
  };

  await Promise.all([
    withTraefikStackLock("srv_1", rmw("a")),
    withTraefikStackLock("srv_1", rmw("b")),
  ]);

  assert.deepEqual(order, ["a:read", "a:write", "b:read", "b:write"]);
});

test("a failed write still lets the next one run", async () => {
  const ran: string[] = [];
  const boom = withTraefikStackLock("srv_2", async () => {
    ran.push("first");
    throw new Error("the host refused it");
  });
  const after = withTraefikStackLock("srv_2", async () => {
    ran.push("second");
    return "ok";
  });

  await assert.rejects(() => boom, /the host refused it/);
  assert.equal(await after, "ok");
  assert.deepEqual(ran, ["first", "second"]);
});

test("different servers are not serialised against each other", async () => {
  const order: string[] = [];
  await Promise.all([
    withTraefikStackLock("srv_3", async () => {
      order.push("slow:start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow:end");
    }),
    withTraefikStackLock("srv_4", async () => {
      order.push("fast");
    }),
  ]);
  assert.deepEqual(order, ["slow:start", "fast", "slow:end"]);
});
