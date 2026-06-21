import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the store onto a throwaway data dir BEFORE the store module loads
// (it captures DATA_DIR at import time), so this test never touches a real
// .deplo/data.json. The store + build modules are imported lazily inside the
// tests because the test runner transpiles to CJS (no top-level await).
process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-reconcile-"));
delete process.env.DEPLO_DATABASE_URL;
delete process.env.DATABASE_URL;

test("isInFlightStatus identifies non-terminal deploy states", async () => {
  const { isInFlightStatus } = await import("./build");
  assert.equal(isInFlightStatus("queued"), true);
  assert.equal(isInFlightStatus("building"), true);
  assert.equal(isInFlightStatus("ready"), false);
  assert.equal(isInFlightStatus("error"), false);
  assert.equal(isInFlightStatus("canceled"), false);
});

test("reconcile marks queued/building deploys (and their projects) errored", async () => {
  const { read, mutate } = await import("../store");
  const { reconcileInFlightDeployments } = await import("./build");
  const { nowIso, newId } = await import("../ids");

  const projectId = newId("prj");
  mutate((d) => {
    d.projects.push({
      id: projectId,
      status: "building",
      updatedAt: nowIso(),
    } as never);
    d.deployments.push(
      { id: "dpl_a", projectId, status: "building", createdAt: nowIso() } as never,
      { id: "dpl_b", projectId, status: "queued", createdAt: nowIso() } as never,
      { id: "dpl_c", projectId, status: "ready", createdAt: nowIso() } as never,
    );
  });

  const n = reconcileInFlightDeployments();
  assert.equal(n, 2, "exactly the two in-flight deploys are reconciled");

  const deps = read().deployments;
  assert.equal(deps.find((x) => x.id === "dpl_a")!.status, "error");
  assert.equal(deps.find((x) => x.id === "dpl_b")!.status, "error");
  assert.equal(deps.find((x) => x.id === "dpl_c")!.status, "ready", "ready is untouched");

  const proj = read().projects.find((p) => p.id === projectId)!;
  assert.equal(proj.status, "error", "the mid-deploy project settles off building");
});

test("reconcile is idempotent — a second run finds nothing", async () => {
  const { reconcileInFlightDeployments } = await import("./build");
  assert.equal(reconcileInFlightDeployments(), 0);
});
