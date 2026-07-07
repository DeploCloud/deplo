import { test } from "node:test";
import assert from "node:assert/strict";

import { groupTargets, resolveEnvEntries } from "./env-resolve";
import type {
  EnvironmentEnvEntryLike,
  GlobalEnvEntryLike,
  SharedEnvGroupLike,
  TargetedEnvEntry,
} from "./env-resolve";

const PID = "proj-1";

function envVar(
  key: string,
  targets: TargetedEnvEntry["targets"],
  serviceId = PID,
): TargetedEnvEntry {
  return { serviceId, key, valueEnc: `enc(${key})`, targets };
}

function group(opts: {
  variables: string[];
  targets?: SharedEnvGroupLike["targets"];
  serviceIds?: string[];
}): SharedEnvGroupLike {
  return {
    serviceIds: opts.serviceIds ?? [PID],
    targets: opts.targets,
    variables: opts.variables.map((k) => ({ key: k, valueEnc: `enc(${k})` })),
  };
}

const keys = (es: { key: string }[]) => es.map((e) => e.key);

// --- groupTargets: legacy default ---

test("groupTargets: missing targets defaults to all three", () => {
  assert.deepEqual(groupTargets({ serviceIds: [], variables: [] }), [
    "production",
    "preview",
    "development",
  ]);
});

test("groupTargets: empty targets array also defaults to all three", () => {
  assert.deepEqual(groupTargets({ serviceIds: [], variables: [], targets: [] }), [
    "production",
    "preview",
    "development",
  ]);
});

test("groupTargets: explicit targets are honoured", () => {
  assert.deepEqual(
    groupTargets({ serviceIds: [], variables: [], targets: ["development"] }),
    ["development"],
  );
});

// --- per-project var selection by target + serviceId ---

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
    group({ variables: ["NOPE"], targets: ["production"], serviceIds: ["proj-2"] }),
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

// --- global scopes (team-global + instance-global) ---

function globalEntry(
  key: string,
  targets: GlobalEnvEntryLike["targets"],
  tag = key,
): GlobalEnvEntryLike {
  return { key, valueEnc: `enc(${tag})`, targets };
}

const ALL = ["production", "preview", "development"] as const;

test("globals apply to every project (no serviceId filter) for their targets", () => {
  const team = [globalEntry("TEAM_VAR", ["production"])];
  const instance = [globalEntry("INST_VAR", ["production"])];
  assert.deepEqual(
    keys(resolveEnvEntries("production", PID, [], [], team, instance)),
    // instance-global emitted first (lowest precedence), then team-global
    ["INST_VAR", "TEAM_VAR"],
  );
});

test("globals respect per-environment targeting", () => {
  const team = [globalEntry("PROD_ONLY", ["production"])];
  assert.deepEqual(resolveEnvEntries("development", PID, [], [], team, []), []);
  assert.deepEqual(
    keys(resolveEnvEntries("production", PID, [], [], team, [])),
    ["PROD_ONLY"],
  );
});

test("precedence (lowest→highest): all-teams < team < project < shared", () => {
  const key = "DATABASE_URL";
  const vars = [envVar(key, [...ALL])];
  const groups = [group({ variables: [key], targets: [...ALL] })];
  const team = [globalEntry(key, [...ALL], "team")];
  const instance = [globalEntry(key, [...ALL], "instance")];
  const out = resolveEnvEntries("production", PID, vars, groups, team, instance);
  // Emission order is lowest precedence first; the caller folds into an object so
  // the LAST wins. So the order must be instance → team → project → shared.
  assert.deepEqual(
    out.map((e) => e.valueEnc),
    ["enc(instance)", "enc(team)", `enc(${key})`, `enc(${key})`],
  );
  // Folding to an object (what build.ts/dev.ts do) → shared wins.
  const folded: Record<string, string> = {};
  for (const e of out) folded[e.key] = e.valueEnc;
  assert.equal(folded[key], `enc(${key})`); // the shared group's value
});

test("a project var overrides a team-global of the same key", () => {
  const key = "API_URL";
  const out = resolveEnvEntries(
    "production",
    PID,
    [envVar(key, ["production"])],
    [],
    [globalEntry(key, ["production"], "team")],
    [],
  );
  const folded: Record<string, string> = {};
  for (const e of out) folded[e.key] = e.valueEnc;
  assert.equal(folded[key], `enc(${key})`); // project wins over team-global
});

test("omitting the global args preserves the old project+shared behaviour", () => {
  const vars = [envVar("X", ["production"])];
  assert.deepEqual(keys(resolveEnvEntries("production", PID, vars, [])), ["X"]);
});

// --- environment-scoped entries (ADR-0008: kind bridges to the target) ---

function environEntry(
  key: string,
  kind: EnvironmentEnvEntryLike["kind"],
  tag = key,
): EnvironmentEnvEntryLike {
  return { key, valueEnc: `enc(${tag})`, kind };
}

test("an environment var reaches only the runtime its kind maps to", () => {
  const envs = [
    environEntry("PROD_VAR", "production"),
    environEntry("DEV_VAR", "development"),
    environEntry("PREVIEW_VAR", "preview"),
  ];
  assert.deepEqual(
    keys(resolveEnvEntries("production", PID, [], [], [], [], envs)),
    ["PROD_VAR"],
  );
  assert.deepEqual(
    keys(resolveEnvEntries("development", PID, [], [], [], [], envs)),
    ["DEV_VAR"],
  );
  assert.deepEqual(
    keys(resolveEnvEntries("preview", PID, [], [], [], [], envs)),
    ["PREVIEW_VAR"],
  );
});

test("a custom environment's vars stay inert (no legacy target matches)", () => {
  const envs = [environEntry("CUSTOM_VAR", "custom")];
  for (const target of ALL) {
    assert.deepEqual(resolveEnvEntries(target, PID, [], [], [], [], envs), []);
  }
});

test("membership entries apply to EVERY runtime, whatever their kind (ADR-0009)", () => {
  // The service LIVES in a Development (or even custom) environment — its
  // environment's vars follow it to any legacy deploy target.
  const envs = [
    { ...environEntry("HOME_VAR", "development"), membership: true },
    { ...environEntry("CUSTOM_HOME_VAR", "custom"), membership: true },
  ];
  for (const target of ALL) {
    assert.deepEqual(keys(resolveEnvEntries(target, PID, [], [], [], [], envs)), [
      "HOME_VAR",
      "CUSTOM_HOME_VAR",
    ]);
  }
});

test("an environment var overrides a team-global of the same key", () => {
  const key = "API_URL";
  const out = resolveEnvEntries(
    "production",
    PID,
    [],
    [],
    [globalEntry(key, ["production"], "team")],
    [],
    [environEntry(key, "production", "environ")],
  );
  assert.deepEqual(
    out.map((e) => e.valueEnc),
    ["enc(team)", "enc(environ)"],
  );
  const folded: Record<string, string> = {};
  for (const e of out) folded[e.key] = e.valueEnc;
  assert.equal(folded[key], "enc(environ)"); // environment wins over team-global
});

test("a service's own var overrides its environment's var of the same key", () => {
  const key = "API_URL";
  const out = resolveEnvEntries(
    "production",
    PID,
    [envVar(key, ["production"])],
    [],
    [],
    [],
    [environEntry(key, "production", "environ")],
  );
  assert.deepEqual(
    out.map((e) => e.valueEnc),
    ["enc(environ)", `enc(${key})`],
  );
  const folded: Record<string, string> = {};
  for (const e of out) folded[e.key] = e.valueEnc;
  assert.equal(folded[key], `enc(${key})`); // the service's own var wins
});

test("full precedence: instance < team < environment < service < shared", () => {
  const key = "DATABASE_URL";
  const out = resolveEnvEntries(
    "production",
    PID,
    [envVar(key, [...ALL])],
    [group({ variables: [key], targets: [...ALL] })],
    [globalEntry(key, [...ALL], "team")],
    [globalEntry(key, [...ALL], "instance")],
    [environEntry(key, "production", "environ")],
  );
  assert.deepEqual(
    out.map((e) => e.valueEnc),
    ["enc(instance)", "enc(team)", "enc(environ)", `enc(${key})`, `enc(${key})`],
  );
});
