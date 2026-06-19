import { test } from "node:test";
import assert from "node:assert/strict";

import { groupTargets, resolveEnvEntries } from "./env-resolve";
import type { SharedEnvGroupLike, TargetedEnvEntry } from "./env-resolve";

const PID = "proj-1";

function envVar(
  key: string,
  targets: TargetedEnvEntry["targets"],
  projectId = PID,
): TargetedEnvEntry {
  return { projectId, key, valueEnc: `enc(${key})`, targets };
}

function group(opts: {
  variables: string[];
  targets?: SharedEnvGroupLike["targets"];
  projectIds?: string[];
}): SharedEnvGroupLike {
  return {
    projectIds: opts.projectIds ?? [PID],
    targets: opts.targets,
    variables: opts.variables.map((k) => ({ key: k, valueEnc: `enc(${k})` })),
  };
}

const keys = (es: { key: string }[]) => es.map((e) => e.key);

// --- groupTargets: legacy default ---

test("groupTargets: missing targets defaults to all three", () => {
  assert.deepEqual(groupTargets({ projectIds: [], variables: [] }), [
    "production",
    "preview",
    "development",
  ]);
});

test("groupTargets: empty targets array also defaults to all three", () => {
  assert.deepEqual(groupTargets({ projectIds: [], variables: [], targets: [] }), [
    "production",
    "preview",
    "development",
  ]);
});

test("groupTargets: explicit targets are honoured", () => {
  assert.deepEqual(
    groupTargets({ projectIds: [], variables: [], targets: ["development"] }),
    ["development"],
  );
});

// --- per-project var selection by target + projectId ---

test("production picks only production-tagged project vars", () => {
  const vars = [
    envVar("PROD_ONLY", ["production"]),
    envVar("DEV_ONLY", ["development"]),
    envVar("BOTH", ["production", "development"]),
  ];
  assert.deepEqual(keys(resolveEnvEntries("production", PID, vars, [])), [
    "PROD_ONLY",
    "BOTH",
  ]);
});

test("development picks only development-tagged project vars", () => {
  const vars = [
    envVar("PROD_ONLY", ["production"]),
    envVar("DEV_ONLY", ["development"]),
  ];
  assert.deepEqual(keys(resolveEnvEntries("development", PID, vars, [])), [
    "DEV_ONLY",
  ]);
});

test("vars from a different project are ignored", () => {
  const vars = [envVar("OTHER", ["production"], "proj-2")];
  assert.deepEqual(resolveEnvEntries("production", PID, vars, []), []);
});

// --- shared group selection by target + attachment ---

test("attached production group reaches the production stack", () => {
  const groups = [group({ variables: ["SHARED"], targets: ["production"] })];
  assert.deepEqual(keys(resolveEnvEntries("production", PID, [], groups)), [
    "SHARED",
  ]);
});

test("development-only group reaches dev but NOT production", () => {
  const groups = [group({ variables: ["DEV_SHARED"], targets: ["development"] })];
  assert.deepEqual(resolveEnvEntries("production", PID, [], groups), []);
  assert.deepEqual(keys(resolveEnvEntries("development", PID, [], groups)), [
    "DEV_SHARED",
  ]);
});

test("production-only group never reaches a dev container", () => {
  const groups = [group({ variables: ["PROD_SHARED"], targets: ["production"] })];
  assert.deepEqual(resolveEnvEntries("development", PID, [], groups), []);
});

test("group attached to another project does not leak in", () => {
  const groups = [
    group({ variables: ["NOPE"], targets: ["production"], projectIds: ["proj-2"] }),
  ];
  assert.deepEqual(resolveEnvEntries("production", PID, [], groups), []);
});

test("legacy group (no targets) reaches production AND development", () => {
  const groups = [group({ variables: ["LEGACY"] })];
  assert.deepEqual(keys(resolveEnvEntries("production", PID, [], groups)), [
    "LEGACY",
  ]);
  assert.deepEqual(keys(resolveEnvEntries("development", PID, [], groups)), [
    "LEGACY",
  ]);
});

// --- ordering / precedence: shared groups appended after project vars ---

test("shared entries come after project vars so they win on key collision", () => {
  const vars = [envVar("DATABASE_URL", ["production"])];
  const groups = [
    group({ variables: ["DATABASE_URL"], targets: ["production"] }),
  ];
  const out = resolveEnvEntries("production", PID, vars, groups);
  // Both present, project-local first, shared last — caller's object-spread
  // therefore lets the shared value override.
  assert.deepEqual(
    out.map((e) => e.valueEnc),
    ["enc(DATABASE_URL)", "enc(DATABASE_URL)"],
  );
  assert.equal(out.length, 2);
});
