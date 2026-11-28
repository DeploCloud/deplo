import { test } from "node:test";
import assert from "node:assert/strict";

import { fleetProblems } from "./fleet-status";
import type { FleetRow } from "./fleet-list";

const row = (cpu: number, memPct: number, diskPct: number): FleetRow => ({
  serverId: "",
  online: true,
  ts: 1,
  cpu,
  memPct,
  diskPct,
  containers: 0,
  agentVersion: null,
  expectedAgentVersion: "",
  source: "",
  spark: [],
});

test("offline comes first, then the fullest; a busy moment below 90% is not a problem", () => {
  const servers = [
    { id: "a", name: "eu-1", status: "online" as const },
    { id: "b", name: "eu-2", status: "online" as const },
    { id: "c", name: "eu-3", status: "offline" as const },
    { id: "d", name: "eu-4", status: "online" as const },
    { id: "e", name: "eu-5", status: "online" as const },
  ];
  const rows = {
    a: row(89, 85, 70),
    b: row(10, 91, 95),
    d: row(97, 20, 30),
  };
  assert.deepEqual(fleetProblems(servers, rows), [
    { id: "c", text: "eu-3 is offline" },
    { id: "d", text: "eu-4 is very busy" },
    { id: "b", text: "eu-2 is almost out of disk" },
  ]);
});

test("a server that has not reported yet is not a problem", () => {
  const servers = [{ id: "a", name: "eu-1", status: "online" as const }];
  assert.deepEqual(
    fleetProblems(servers, { a: { ...row(99, 99, 99), ts: 0 } }),
    [],
  );
  assert.deepEqual(fleetProblems(servers, {}), []);
});
