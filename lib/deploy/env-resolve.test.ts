import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveEnvEntries } from "./env-resolve";
import type {
  GlobalEnvEntryLike,
  SharedVarEntry,
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
  targets: SharedVarEntry["targets"] = [...ALL],
  tag = key,
): SharedVarEntry {
  return { key, valueEnc: `enc(${tag})`, targets };
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

/* --- shared (opted-in) var selection by target --- */

test("a linked shared var reaches a runtime only when it targets it", () => {
  const s = [shared("SHARED", ["production"])];
  assert.deepEqual(keys(resolveEnvEntries("production", APP, [], s)), ["SHARED"]);
  assert.deepEqual(resolveEnvEntries("development", APP, [], s), []);
});

/* --- precedence (the correctness spine, ADR-0012) --- */

test("full precedence order: instance < app-own < linked shared", () => {
  const key = "DATABASE_URL";
  const out = resolveEnvEntries(
    "production",
    APP,
    [envVar(key, [...ALL])],
    [shared(key, [...ALL], "link")],
    [globalEntry(key, [...ALL], "instance")],
  );
  // Emission is lowest-precedence first; the caller folds into an object so the
  // LAST wins.
  assert.deepEqual(
    out.map((e) => e.valueEnc),
    ["enc(instance)", `enc(${key})`, "enc(link)"],
  );
  assert.equal(fold(out)[key], "enc(link)"); // the explicit opt-in wins
});

test("parity: a per-app link (old shared group) overrides the app's own var", () => {
  const key = "API_URL";
  const out = resolveEnvEntries(
    "production",
    APP,
    [envVar(key, ["production"])],
    [shared(key, ["production"], "link")],
  );
  assert.equal(fold(out)[key], "enc(link)"); // link wins over app-own
});

/* --- globals + within-layer ordering --- */

test("instance globals apply to every app and sit lowest", () => {
  const key = "X";
  const out = resolveEnvEntries(
    "production",
    APP,
    [envVar(key, ["production"])],
    [],
    [globalEntry(key, ["production"], "instance")],
  );
  assert.deepEqual(
    out.map((e) => e.valueEnc),
    ["enc(instance)", `enc(${key})`],
  );
  assert.equal(fold(out)[key], `enc(${key})`); // the app's own var beats instance
});

test("within the shared layer, the later entry wins on a key collision", () => {
  // The loader supplies shared vars sorted created_at ASC → later wins on fold.
  const out = resolveEnvEntries(
    "production",
    APP,
    [],
    [shared("K", ["production"], "older"), shared("K", ["production"], "newer")],
  );
  assert.equal(fold(out)["K"], "enc(newer)");
});

test("omitting instanceGlobals defaults to the app-own + shared behaviour", () => {
  const vars = [envVar("X", ["production"])];
  assert.deepEqual(keys(resolveEnvEntries("production", APP, vars, [])), ["X"]);
});
