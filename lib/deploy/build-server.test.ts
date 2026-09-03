import test from "node:test";
import assert from "node:assert/strict";

import {
  pickBuildServer,
  pickBuildFallbacks,
  planBuildServers,
  canBuildFor,
  buildPlanLines,
} from "./build-server";
import type { Server } from "../types";

/**
 * The build-server CHOICE, tested without a database or an agent - the whole point
 * of splitting the pure `pickBuildServer` out of `resolveBuildPlan`.
 */

function srv(over: Partial<Server> & { id: string }): Server {
  return {
    id: over.id,
    name: over.name ?? over.id,
    host: over.host ?? `10.0.0.${over.id.length}`,
    type: "remote",
    status: over.status ?? "online",
    ip: over.ip ?? over.host ?? `10.0.0.${over.id.length}`,
    dockerVersion: "27",
    traefikEnabled: true,
    cpuCores: 4,
    memoryMb: 8192,
    diskGb: 100,
    allTeams: true,
    storageOnly: over.storageOnly ?? false,
    buildOnly: over.buildOnly ?? false,
    buildFallback: over.buildFallback ?? null,
    importOnly: over.importOnly ?? false,
    uninstallPending: false,
    uninstallError: "",
    hostArch: over.hostArch ?? "amd64",
    deployConcurrency: 1,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

const TARGET = srv({ id: "srv_app", ip: "10.0.0.9" });
const app = (buildServerId: string | null = null) => ({
  serverId: "srv_app",
  buildServerId,
});
/** The app plus the per-app fallback switch, which defaults on like the column. */
const plannedApp = (
  buildServerId: string | null = null,
  buildFallback = true,
) => ({
  ...app(buildServerId),
  buildFallback,
});
/** The Deplo host, and the addresses that identify it. */
const DEPLO_HOST = srv({ id: "srv_panel", ip: "10.0.0.1", host: "10.0.0.1" });
const SELF = new Set(["10.0.0.1"]);

test("no build server in the fleet leaves the deploy exactly as it was", () => {
  const choice = pickBuildServer(app(), TARGET, [
    TARGET,
    srv({ id: "srv_other" }),
  ]);
  assert.deepEqual(choice, { serverId: null, reason: "none-available" });
});

test("a build-only server is used automatically, without anyone opting in", () => {
  const builder = srv({ id: "srv_build", buildOnly: true });
  const choice = pickBuildServer(app(), TARGET, [TARGET, builder]);
  assert.deepEqual(choice, { serverId: "srv_build", reason: "automatic" });
});

test("an ordinary server is never picked automatically - only a dedicated one", () => {
  // It IS offerable as an explicit pin (listBuildServerChoices includes it), but
  // silently borrowing someone else's production host to build on is not a default
  // anybody asked for.
  const other = srv({ id: "srv_other", buildOnly: false });
  const choice = pickBuildServer(app(), TARGET, [TARGET, other]);
  assert.deepEqual(choice, { serverId: null, reason: "none-available" });
});

test("a pin beats a healthier automatic choice - a setting that reroutes is not a setting", () => {
  const pinned = srv({ id: "srv_pin" });
  const idleBuilder = srv({ id: "srv_build", buildOnly: true });
  const choice = pickBuildServer(
    app("srv_pin"),
    TARGET,
    [TARGET, pinned, idleBuilder],
    new Map([["srv_pin", 5]]),
  );
  assert.deepEqual(choice, { serverId: "srv_pin", reason: "pinned" });
});

test("pinning the app's OWN server means build here, even with a builder available", () => {
  const builder = srv({ id: "srv_build", buildOnly: true });
  const choice = pickBuildServer(app("srv_app"), TARGET, [TARGET, builder]);
  assert.deepEqual(choice, { serverId: null, reason: "own-server" });
});

test("a mismatched architecture is refused, not warned about", () => {
  // The failure this prevents: an amd64 image loads fine on an arm64 host and the
  // deploy reports success, then the container dies with `exec format error`.
  const builder = srv({ id: "srv_build", buildOnly: true, hostArch: "arm64" });
  assert.deepEqual(pickBuildServer(app(), TARGET, [TARGET, builder]), {
    serverId: null,
    reason: "none-available",
  });
  // Pinned, the same refusal gets its own reason so the log can say WHY.
  assert.deepEqual(
    pickBuildServer(app("srv_build"), TARGET, [TARGET, builder]),
    {
      serverId: null,
      reason: "arch-mismatch",
    },
  );
});

test("an agent too old to report its architecture is never used as a builder", () => {
  const builder = srv({ id: "srv_build", buildOnly: true, hostArch: "" });
  assert.equal(
    pickBuildServer(app(), TARGET, [TARGET, builder]).serverId,
    null,
  );
  // And a target of unknown arch is equally unsafe to build FOR.
  const unknownTarget = srv({ id: "srv_app", hostArch: "" });
  const known = srv({ id: "srv_build", buildOnly: true, hostArch: "amd64" });
  assert.equal(
    pickBuildServer(app(), unknownTarget, [unknownTarget, known]).serverId,
    null,
  );
});

test("an offline or still-provisioning builder is skipped before it is dialed", () => {
  for (const status of ["offline", "provisioning"] as const) {
    const builder = srv({ id: "srv_build", buildOnly: true, status });
    assert.equal(
      pickBuildServer(app(), TARGET, [TARGET, builder]).serverId,
      null,
    );
  }
});

test("a storage-only server can never build - it has no Docker", () => {
  const box = srv({ id: "srv_store", storageOnly: true, buildOnly: false });
  assert.equal(canBuildFor(box, TARGET), false);
});

test("a migration source can never build - it HAS Docker, and that is the trap", () => {
  // Every other "can this machine build?"
  const box = srv({ id: "srv_import", importOnly: true, hostArch: "amd64" });
  assert.equal(canBuildFor(box, TARGET), false);
  // And it is never picked automatically either, even alone in the fleet.
  assert.equal(pickBuildServer(app(), TARGET, [TARGET, box]).serverId, null);
});

test("the least busy builder wins, and ties break on creation order", () => {
  const a = srv({
    id: "srv_a",
    buildOnly: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const b = srv({
    id: "srv_b",
    buildOnly: true,
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(
    pickBuildServer(app(), TARGET, [TARGET, a, b], new Map([["srv_a", 3]]))
      .serverId,
    "srv_b",
  );
  // A tie must be DETERMINISTIC: two deploys racing must not depend on map order.
  assert.equal(
    pickBuildServer(app(), TARGET, [TARGET, b, a]).serverId,
    "srv_a",
  );
  assert.equal(
    pickBuildServer(app(), TARGET, [TARGET, a, b]).serverId,
    "srv_a",
  );
});

test("a pin to a server this team lost access to degrades instead of failing", () => {
  // The server is simply absent from `candidates` - removed, or its grant revoked.
  // The app still has to deploy, so this becomes "build where it runs" plus a
  // warning, never an error and never a silent substitution of another builder.
  const otherBuilder = srv({ id: "srv_build", buildOnly: true });
  const choice = pickBuildServer(app("srv_gone"), TARGET, [
    TARGET,
    otherBuilder,
  ]);
  assert.deepEqual(choice, { serverId: null, reason: "none-available" });
});

/* ------------------------------------------------------------------ */
/* The fallback pool                                                   */
/* ------------------------------------------------------------------ */

test("the Deplo host is a build fallback with nobody configuring anything", () => {
  const remote = srv({ id: "srv_remote", ip: "10.0.0.2" });
  assert.deepEqual(
    pickBuildFallbacks(TARGET, [TARGET, DEPLO_HOST, remote], SELF).map(
      (s) => s.id,
    ),
    ["srv_panel"],
  );
});

test("a server joins the pool only when it is marked, and the Deplo host leads it", () => {
  const marked = srv({ id: "srv_spare", ip: "10.0.0.2", buildFallback: true });
  assert.deepEqual(
    pickBuildFallbacks(TARGET, [TARGET, marked, DEPLO_HOST], SELF).map(
      (s) => s.id,
    ),
    ["srv_panel", "srv_spare"],
  );
});

test("the Deplo host can be taken out of the pool, and then it is not asked", () => {
  const off = srv({ ...DEPLO_HOST, buildFallback: false });
  assert.deepEqual(pickBuildFallbacks(TARGET, [TARGET, off], SELF), []);
});

test("a fallback must be able to build for THIS target, like any other builder", () => {
  const arm = srv({
    id: "srv_arm",
    ip: "10.0.0.2",
    buildFallback: true,
    hostArch: "arm64",
  });
  const down = srv({
    id: "srv_down",
    ip: "10.0.0.3",
    buildFallback: true,
    status: "offline",
  });
  const store = srv({
    id: "srv_store",
    ip: "10.0.0.4",
    buildFallback: true,
    storageOnly: true,
  });
  const source = srv({
    id: "srv_import",
    ip: "10.0.0.5",
    buildFallback: true,
    importOnly: true,
  });
  const itself = srv({ ...TARGET, buildFallback: true });
  assert.deepEqual(
    pickBuildFallbacks(TARGET, [itself, arm, down, store, source], SELF),
    [],
  );
});

test("two marked fallbacks split the load, deterministically", () => {
  const a = srv({
    id: "srv_a",
    ip: "10.0.0.2",
    buildFallback: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const b = srv({
    id: "srv_b",
    ip: "10.0.0.3",
    buildFallback: true,
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  assert.deepEqual(
    pickBuildFallbacks(TARGET, [b, a], SELF, new Map([["srv_a", 2]])).map(
      (s) => s.id,
    ),
    ["srv_b", "srv_a"],
  );
  assert.deepEqual(
    pickBuildFallbacks(TARGET, [b, a], SELF).map((s) => s.id),
    ["srv_a", "srv_b"],
  );
});

/* ------------------------------------------------------------------ */
/* The whole plan                                                      */
/* ------------------------------------------------------------------ */

test("a fleet with no build server is untouched by any of this", () => {
  // The regression that would hurt everyone: an ordinary install suddenly shipping
  // its builds to the panel host.
  assert.deepEqual(
    planBuildServers(plannedApp(), TARGET, [TARGET, DEPLO_HOST], SELF),
    { chain: [], local: true, missed: null },
  );
});

test("an app pinned to its own server asks no fallback question", () => {
  assert.deepEqual(
    planBuildServers(plannedApp("srv_app"), TARGET, [TARGET, DEPLO_HOST], SELF),
    { chain: [], local: true, missed: null },
  );
});

test("a healthy build server is first, and the fallbacks queue behind it", () => {
  const builder = srv({ id: "srv_build", ip: "10.0.0.2", buildOnly: true });
  const plan = planBuildServers(
    plannedApp("srv_build"),
    TARGET,
    [TARGET, builder, DEPLO_HOST],
    SELF,
  );
  assert.deepEqual(plan, {
    chain: ["srv_build", "srv_panel"],
    local: true,
    missed: null,
  });
});

test("the per-app switch off leaves exactly one host and no way out", () => {
  const builder = srv({ id: "srv_build", ip: "10.0.0.2", buildOnly: true });
  assert.deepEqual(
    planBuildServers(
      plannedApp("srv_build", false),
      TARGET,
      [TARGET, builder, DEPLO_HOST],
      SELF,
    ),
    { chain: ["srv_build"], local: false, missed: null },
  );
});

test("a build server that is down hands the build to the fallback, not to the app's server", () => {
  const builder = srv({
    id: "srv_build",
    ip: "10.0.0.2",
    buildOnly: true,
    status: "offline",
  });
  const plan = planBuildServers(
    plannedApp("srv_build"),
    TARGET,
    [TARGET, builder, DEPLO_HOST],
    SELF,
  );
  assert.deepEqual(plan, {
    chain: ["srv_panel"],
    local: true,
    missed: { reason: "none-available", pinned: true },
  });
});

test("with the switch off, a build server that is down FAILS the deploy", () => {
  // The bug this closes: the pin was dropped at enqueue and the app's own server
  // built it anyway, which is the one thing the switch promises will not happen.
  for (const builder of [
    srv({
      id: "srv_build",
      ip: "10.0.0.2",
      buildOnly: true,
      status: "offline",
    }),
    srv({
      id: "srv_build",
      ip: "10.0.0.2",
      buildOnly: true,
      hostArch: "arm64",
    }),
  ]) {
    const plan = planBuildServers(
      plannedApp("srv_build", false),
      TARGET,
      [TARGET, builder, DEPLO_HOST],
      SELF,
    );
    assert.deepEqual(plan.chain, []);
    assert.equal(plan.local, false);
    assert.equal(plan.missed?.pinned, true);
  }
});

test("an arch-mismatched pin never sends the build there, switch on or off", () => {
  const builder = srv({
    id: "srv_build",
    ip: "10.0.0.2",
    buildOnly: true,
    hostArch: "arm64",
  });
  const plan = planBuildServers(
    plannedApp("srv_build"),
    TARGET,
    [TARGET, builder, DEPLO_HOST],
    SELF,
  );
  assert.deepEqual(plan, {
    chain: ["srv_panel"],
    local: true,
    missed: { reason: "arch-mismatch", pinned: true },
  });
});

test("Automatic falls back too, and says nobody chose that server", () => {
  const builder = srv({
    id: "srv_build",
    ip: "10.0.0.2",
    buildOnly: true,
    status: "offline",
  });
  const plan = planBuildServers(
    plannedApp(),
    TARGET,
    [TARGET, builder, DEPLO_HOST],
    SELF,
  );
  assert.deepEqual(plan, {
    chain: ["srv_panel"],
    local: true,
    missed: { reason: "none-available", pinned: false },
  });
});

test("the app's own server is the last link, never a pool member", () => {
  // Marked or not, the target is not in the chain: `local` is what allows it, and
  // that is what the per-app switch turns off.
  const self = srv({ ...TARGET, buildFallback: true });
  const builder = srv({
    id: "srv_build",
    ip: "10.0.0.2",
    buildOnly: true,
    status: "offline",
  });
  const plan = planBuildServers(plannedApp("srv_build"), TARGET, [
    self,
    builder,
  ]);
  assert.deepEqual(plan.chain, []);
  assert.equal(plan.local, true);
});

/* ------------------------------------------------------------------ */
/* What the deploy log says                                            */
/* ------------------------------------------------------------------ */

const NAMES: Record<string, string> = {
  srv_build: "eu-build-1",
  srv_panel: "eu-main-1",
};
const nameOf = (id: string) => NAMES[id] ?? id;

test("the deploy log is silent for the default and loud when a setting did not apply", () => {
  assert.deepEqual(
    buildPlanLines(
      { chain: [], local: true, missed: null },
      nameOf,
      "eu-app-1",
    ),
    [],
  );
  const [ok] = buildPlanLines(
    { chain: ["srv_build"], local: true, missed: null },
    nameOf,
    "eu-app-1",
  );
  assert.equal(ok.level, "info");
  assert.match(ok.text, /eu-build-1/);
  assert.match(ok.text, /eu-app-1/);
});

test("a fallback names both the host that could not and the one that took over", () => {
  const [line] = buildPlanLines(
    {
      chain: ["srv_panel"],
      local: true,
      missed: { reason: "arch-mismatch", pinned: true },
    },
    nameOf,
    "eu-app-1",
  );
  assert.equal(line.level, "warn");
  assert.match(line.text, /architecture/);
  assert.match(line.text, /Building on eu-main-1 instead/);
  // Automatic never claims the app chose anything.
  const [auto] = buildPlanLines(
    {
      chain: [],
      local: true,
      missed: { reason: "none-available", pinned: false },
    },
    nameOf,
    "eu-app-1",
  );
  assert.match(auto.text, /No build server in this fleet/);
  assert.match(auto.text, /Building on eu-app-1 instead/);
});

test("a refused deploy says so as an error, and says the running version is safe", () => {
  const [line] = buildPlanLines(
    {
      chain: [],
      local: false,
      missed: { reason: "none-available", pinned: true },
    },
    nameOf,
    "eu-app-1",
  );
  assert.equal(line.level, "error");
  assert.match(line.text, /not to build anywhere else/);
  assert.match(line.text, /running version was not touched/);
});
