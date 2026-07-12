import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveEnvEntries } from "./env-resolve";
import type {
  GlobalEnvEntryLike,
  SharedVarEntry,
  SharedVarMode,
  TargetedEnvEntry,
} from "./env-resolve";

const APP = "prj-1";
const ALL = ["production", "preview", "development"] as const;

function envVar(
  key: string,
  targets: TargetedEnvEntry["targets"],
  appId = APP,
): TargetedEnvEntry {
  return { appId, key, valueEnc: `enc(${key})`, targets };
}

function shared(
  key: string,
  mode: SharedVarMode,
  targets: SharedVarEntry["targets"] = [...ALL],
  tag = key,
): SharedVarEntry {
  return { key, valueEnc: `enc(${tag})`, targets, mode };
}

function globalEntry(
  key: string,
  targets: GlobalEnvEntryLike["targets"],
  tag = key,
): GlobalEnvEntryLike {
  return { key, valueEnc: `enc(${tag})`, targets };
}

const keys = (es: { key: string }[]) => es.map((e) => e.key);
const fold = (es: { key: string; valueEnc: string }[]) => {
  const o: Record<string, string> = {};
  for (const e of es) o[e.key] = e.valueEnc;
  return o;
};

/* --- app-own var selection by target + appId --- */

test("production picks only production-tagged app vars", () => {
  const vars = [
    envVar("PROD_ONLY", ["production"]),
    envVar("DEV_ONLY", ["development"]),
    envVar("BOTH", ["production", "development"]),
  ];
  assert.deepEqual(keys(resolveEnvEntries("production", APP, vars, [])), [
    "PROD_ONLY",
    "BOTH",
  ]);
});

test("vars from a different app are ignored", () => {
  const vars = [envVar("OTHER", ["production"], "prj-2")];
  assert.deepEqual(resolveEnvEntries("production", APP, vars, []), []);
});

/* --- shared var selection by target + mode --- */

test("a shared var reaches a runtime only when it targets it", () => {
  const s = [shared("SHARED", "teamWide", ["production"])];
  assert.deepEqual(keys(resolveEnvEntries("production", APP, [], s)), ["SHARED"]);
  assert.deepEqual(resolveEnvEntries("development", APP, [], s), []);
});

test("every sharing mode reaches the app for its targets", () => {
  const s = [
    shared("A", "teamWide"),
    shared("B", "environment"),
    shared("C", "project"),
    shared("D", "link"),
  ];
  assert.deepEqual(keys(resolveEnvEntries("production", APP, [], s)).sort(), [
    "A",
    "B",
    "C",
    "D",
  ]);
});

/* --- precedence (the correctness spine) --- */

test("full precedence order: instance < teamWide < environment < app-own < project < link", () => {
  const key = "DATABASE_URL";
  const out = resolveEnvEntries(
    "production",
    APP,
    [envVar(key, [...ALL])],
    [
      shared(key, "teamWide", [...ALL], "teamWide"),
      shared(key, "environment", [...ALL], "environment"),
      shared(key, "project", [...ALL], "project"),
      shared(key, "link", [...ALL], "link"),
    ],
    [globalEntry(key, [...ALL], "instance")],
  );
  // Emission is lowest-precedence first; the caller folds into an object so the
  // LAST wins.
  assert.deepEqual(
    out.map((e) => e.valueEnc),
    [
      "enc(instance)",
      "enc(teamWide)",
      "enc(environment)",
      `enc(${key})`,
      "enc(project)",
      "enc(link)",
    ],
  );
  assert.equal(fold(out)[key], "enc(link)"); // most specific wins
});

/* --- migration parity: each old system keeps its old slot vs app-own --- */

test("parity: team-wide (old team-global) loses to the app's own var", () => {
  const key = "API_URL";
  const out = resolveEnvEntries(
    "production",
    APP,
    [envVar(key, ["production"])],
    [shared(key, "teamWide", ["production"], "teamWide")],
  );
  assert.equal(fold(out)[key], `enc(${key})`); // app-own wins over team-wide
});

test("parity: environment shared (old environment var) loses to the app's own var", () => {
  const key = "API_URL";
  const out = resolveEnvEntries(
    "production",
    APP,
    [envVar(key, ["production"])],
    [shared(key, "environment", ["production"], "environ")],
  );
  assert.equal(fold(out)[key], `enc(${key})`); // app-own wins over environment
});

test("parity: a per-app link (old shared group) overrides the app's own var", () => {
  const key = "API_URL";
  const out = resolveEnvEntries(
    "production",
    APP,
    [envVar(key, ["production"])],
    [shared(key, "link", ["production"], "link")],
  );
  assert.equal(fold(out)[key], "enc(link)"); // link wins over app-own
});

test("parity: environment shared applies to every runtime (targets = all)", () => {
  // Migrated environment vars carry all three targets → they reach every runtime,
  // reproducing the old membership behaviour.
  const s = [shared("HOME", "environment", [...ALL])];
  for (const target of ALL) {
    assert.deepEqual(keys(resolveEnvEntries(target, APP, [], s)), ["HOME"]);
  }
});

/* --- globals + within-layer ordering --- */

test("instance globals apply to every app and sit lowest", () => {
  const key = "X";
  const out = resolveEnvEntries(
    "production",
    APP,
    [],
    [shared(key, "teamWide", ["production"], "teamWide")],
    [globalEntry(key, ["production"], "instance")],
  );
  assert.deepEqual(
    out.map((e) => e.valueEnc),
    ["enc(instance)", "enc(teamWide)"],
  );
  assert.equal(fold(out)[key], "enc(teamWide)"); // team-wide beats instance
});

test("within one layer, the later entry wins on a key collision", () => {
  // The loader supplies shared vars sorted created_at ASC → later wins on fold.
  const out = resolveEnvEntries(
    "production",
    APP,
    [],
    [
      shared("K", "teamWide", ["production"], "older"),
      shared("K", "teamWide", ["production"], "newer"),
    ],
  );
  assert.equal(fold(out)["K"], "enc(newer)");
});

test("omitting instanceGlobals defaults to the app-own + shared behaviour", () => {
  const vars = [envVar("X", ["production"])];
  assert.deepEqual(keys(resolveEnvEntries("production", APP, vars, [])), ["X"]);
});
