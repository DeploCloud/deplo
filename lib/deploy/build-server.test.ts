import test from "node:test";
import assert from "node:assert/strict";

import {
  pickBuildServer,
  canBuildFor,
  buildServerLogLine,
} from "./build-server";
import type { Server } from "../types";

/**
 * The build-server CHOICE, tested without a database or an agent - the whole point
 * of splitting the pure `pickBuildServer` out of `resolveBuildServer`.
 */

function srv(over: Partial<Server> & { id: string }): Server {
  return {
    id: over.id,
    name: over.name ?? over.id,
    host: "10.0.0.1",
    type: "remote",
    status: over.status ?? "online",
    ip: "10.0.0.1",
    dockerVersion: "27",
    traefikEnabled: true,
    cpuCores: 4,
    memoryMb: 8192,
    diskGb: 100,
    cpuUsage: 0,
    memoryUsage: 0,
    diskUsage: 0,
    allTeams: true,
    storageOnly: over.storageOnly ?? false,
    buildOnly: over.buildOnly ?? false,
    importOnly: over.importOnly ?? false,
    uninstallPending: false,
    uninstallError: "",
    hostArch: over.hostArch ?? "amd64",
    deployConcurrency: 1,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

const TARGET = srv({ id: "srv_app" });
const app = (buildServerId: string | null = null) => ({
  serverId: "srv_app",
  buildServerId,
});

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
  // Every other "can this machine build?" check reads storageOnly, which a migration
  // source passes: the other platform's host obviously has Docker.
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

test("the deploy log is silent for the default and loud when a setting did not apply", () => {
  assert.equal(
    buildServerLogLine(
      { serverId: null, reason: "own-server" },
      "b",
      "eu-main-1",
    ),
    null,
  );
  const ok = buildServerLogLine(
    { serverId: "srv_build", reason: "automatic" },
    "eu-build-1",
    "eu-main-1",
  );
  assert.equal(ok?.level, "info");
  assert.match(ok!.text, /eu-build-1/);
  assert.match(ok!.text, /eu-main-1/);
  for (const reason of ["arch-mismatch", "none-available"] as const) {
    const warn = buildServerLogLine(
      { serverId: null, reason },
      "eu-build-1",
      "eu-main-1",
    );
    assert.equal(warn?.level, "warn");
    assert.match(warn!.text, /eu-main-1/);
  }
});
