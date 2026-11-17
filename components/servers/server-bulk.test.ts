import { test } from "node:test";
import assert from "node:assert/strict";

import { oneByOne, planBulkJoin, type BulkServer } from "./server-bulk";

const s = (id: string, cluster: BulkServer["cluster"] = null): BulkServer => ({
  id,
  name: id,
  ip: "203.0.113.10",
  cluster,
});
const option = (id: string, blocked = "", apps = 0) => ({
  serverId: id,
  serverName: id,
  blocked,
  apps,
  databases: 0,
});

test("a bulk move takes the servers that can join and says why the others stay out", () => {
  const plan = planBulkJoin(
    [
      s("free"),
      s("busy"),
      s("blocked"),
      s("inside", { id: "clu_eu", name: "eu" }),
      s("elsewhere", { id: "clu_us", name: "us" }),
      s("unknown"),
    ],
    {
      id: "clu_eu",
      name: "eu",
      joinOptions: [
        option("free"),
        option("busy", "", 3),
        option("blocked", "Its agent is too old"),
      ],
    },
  );
  assert.deepEqual(
    plan.joining.map((o) => o.serverId),
    ["free", "busy"],
  );
  assert.deepEqual(plan.skipped, [
    { name: "blocked", reason: "Its agent is too old" },
    { name: "inside", reason: "already in eu" },
    { name: "elsewhere", reason: "in us" },
    { name: "unknown", reason: "it cannot join a cluster" },
  ]);
});

test("one by one keeps going past a refusal and says how many went through", async () => {
  const seen: string[] = [];
  const res = await oneByOne(
    ["a", "b", "c"],
    (x) => x,
    async (x) => {
      seen.push(x);
      return x === "b" ? { ok: false, error: "refused" } : { ok: true };
    },
  );
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(res, { ok: false, error: "2 of 3 done. b: refused" });
  assert.deepEqual(
    await oneByOne(
      ["a"],
      (x) => x,
      async () => ({ ok: true }),
    ),
    { ok: true, data: 1 },
  );
});
