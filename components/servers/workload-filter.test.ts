import test from "node:test";
import assert from "node:assert/strict";

import type { ServerWorkload } from "@/lib/data/servers/workloads";
import { filterWorkloads } from "./workload-filter";

function w(over: Partial<ServerWorkload>): ServerWorkload {
  return {
    id: "prj_x",
    kind: "app",
    name: "web",
    logo: null,
    logoTone: null,
    engine: null,
    teamName: "Acme",
    href: null,
    project: null,
    environment: null,
    domain: null,
    status: "active",
    cpu: null,
    memUsed: null,
    restarts: 0,
    containers: [],
    ...over,
  };
}

const ROWS = [
  w({ id: "web", name: "web", domain: "https://shop.acme.com" }),
  w({ id: "loop", name: "worker", status: "restarting" }),
  w({ id: "off", name: "blog", status: "idle" }),
  w({ id: "db", name: "main", kind: "database", engine: "postgres" }),
];
const ids = (q: Parameters<typeof filterWorkloads>[1]) =>
  filterWorkloads(ROWS, q).map((r) => r.id);
const ALL = { query: "", status: "all", kind: "all" } as const;

test("no search and no filter shows everything", () => {
  assert.deepEqual(ids(ALL), ["web", "loop", "off", "db"]);
});

test("search reaches the domain and the engine", () => {
  assert.deepEqual(ids({ ...ALL, query: "shop" }), ["web"]);
  assert.deepEqual(ids({ ...ALL, query: "postgres" }), ["db"]);
});

test("a restarting app is failing, an idle one stopped", () => {
  assert.deepEqual(ids({ ...ALL, status: "failing" }), ["loop"]);
  assert.deepEqual(ids({ ...ALL, status: "stopped" }), ["off"]);
  assert.deepEqual(ids({ ...ALL, kind: "database" }), ["db"]);
});
