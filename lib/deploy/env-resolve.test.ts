import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveEnvEntries } from "./env-resolve";
import type {
  GlobalEnvEntryLike,
  SharedVarEntry,
  TargetedEnvEntry,
} from "./env-resolve";

const APP = "prj-1";
const ALL = ["production", "preview"] as const;

function envVar(
  key: string,
  targets: TargetedEnvEntry["targets"],
  appId = APP,
): TargetedEnvEntry {
  return { appId, key, valueEnc: `enc(${key})`, targets, type: "plain" };
}

function shared(
  key: string,
  targets: SharedVarEntry["targets"] = [...ALL],
  tag = key,
): SharedVarEntry {
  return { key, valueEnc: `enc(${tag})`, targets, type: "plain" };
}

function globalEntry(
  key: string,
  targets: GlobalEnvEntryLike["targets"],
  tag = key,
): GlobalEnvEntryLike {
  return { key, valueEnc: `enc(${tag})`, targets, type: "plain" };
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
    envVar("PREVIEW_ONLY", ["preview"]),
    envVar("BOTH", ["production", "preview"]),
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
  assert.deepEqual(keys(resolveEnvEntries("production", APP, [], s)), [
    "SHARED",
  ]);
  assert.deepEqual(resolveEnvEntries("preview", APP, [], s), []);
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
    [
      shared("K", ["production"], "older"),
      shared("K", ["production"], "newer"),
    ],
  );
  assert.equal(fold(out)["K"], "enc(newer)");
});

test("omitting instanceGlobals defaults to the app-own + shared behaviour", () => {
  const vars = [envVar("X", ["production"])];
  assert.deepEqual(keys(resolveEnvEntries("production", APP, vars, [])), ["X"]);
});

/* ------------------------------------------------------------------ */
/* Preview overrides (ADR-0014)                                        */
/* ------------------------------------------------------------------ */

test("a preview override beats the app's own var AND a linked shared var", () => {
  // The whole reason overrides exist: pointing a pull request's preview at a
  // scratch database. A team-wide shared value outranking it would make that
  // impossible.
  const out = resolveEnvEntries(
    "preview",
    APP,
    [envVar("DATABASE_URL", ["production", "preview"])],
    [shared("DATABASE_URL", ["production", "preview"], "team-default")],
    [globalEntry("DATABASE_URL", ["production", "preview"], "instance")],
    [{ key: "DATABASE_URL", valueEnc: "enc(scratch)", type: "plain" as const }],
  );
  assert.equal(fold(out)["DATABASE_URL"], "enc(scratch)");
  // Lowest precedence first, override last.
  assert.deepEqual(
    out.map((e) => e.valueEnc),
    ["enc(instance)", "enc(DATABASE_URL)", "enc(team-default)", "enc(scratch)"],
  );
});

test("an override can introduce a key that exists nowhere else", () => {
  const out = resolveEnvEntries(
    "preview",
    APP,
    [],
    [],
    [],
    [{ key: "PREVIEW_ONLY", valueEnc: "enc(v)", type: "plain" as const }],
  );
  assert.deepEqual(keys(out), ["PREVIEW_ONLY"]);
});

test("overrides NEVER reach production, even when supplied", () => {
  const out = resolveEnvEntries(
    "production",
    APP,
    [envVar("DATABASE_URL", ["production", "preview"])],
    [],
    [],
    [{ key: "DATABASE_URL", valueEnc: "enc(scratch)", type: "plain" as const }],
  );
  assert.equal(fold(out)["DATABASE_URL"], "enc(DATABASE_URL)");
});

test("omitting overrides leaves every existing caller byte-identical", () => {
  const vars = [envVar("X", ["production", "preview"])];
  const sharedVars = [shared("Y", ["production", "preview"], "s")];
  assert.deepEqual(
    resolveEnvEntries("preview", APP, vars, sharedVars, []),
    resolveEnvEntries("preview", APP, vars, sharedVars, [], []),
  );
});
