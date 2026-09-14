import { test } from "node:test";
import assert from "node:assert/strict";

import {
  envNeedsInterpolation,
  parseEnvBlob,
  renameDatabaseHosts,
  resolveSharedRefs,
  sharedRefsIn,
} from "./env";

test("parseEnvBlob follows the .env grammar Deplo already uses", () => {
  const entries = parseEnvBlob(
    [
      "# a comment",
      "",
      "PLAIN=value",
      'QUOTED="with spaces"',
      "SINGLE='single'",
      "export EXPORTED=shell-style",
      "EMPTY=",
      "WITH_EQUALS=a=b=c",
      "not a var line",
      "1BAD=nope",
      "SPACED = trimmed ",
    ].join("\n"),
  );
  assert.deepEqual(entries, [
    { key: "PLAIN", value: "value" },
    { key: "QUOTED", value: "with spaces" },
    { key: "SINGLE", value: "single" },
    { key: "EXPORTED", value: "shell-style" },
    { key: "EMPTY", value: "" },
    { key: "WITH_EQUALS", value: "a=b=c" },
    { key: "SPACED", value: "trimmed" },
  ]);
});

test("parseEnvBlob keeps the last value for a repeated key", () => {
  assert.deepEqual(parseEnvBlob("A=1\nB=2\nA=3"), [
    { key: "A", value: "3" },
    { key: "B", value: "2" },
  ]);
});

test("parseEnvBlob tolerates nothing at all", () => {
  assert.deepEqual(parseEnvBlob(null), []);
  assert.deepEqual(parseEnvBlob(""), []);
});

test("sharedRefsIn reads both panels' syntax, at all four levels", () => {
  const entries = parseEnvBlob(
    [
      "A={{team.SMTP_HOST}}",
      "B=${{project.DB_URL}}",
      "C={{ environment.API }}",
      "D=https://{{server.HOST}}/api",
      "E=literal",
    ].join("\n"),
  );
  assert.deepEqual(sharedRefsIn(entries), [
    { key: "A", level: "team", sharedKey: "SMTP_HOST", whole: true },
    { key: "B", level: "project", sharedKey: "DB_URL", whole: true },
    { key: "C", level: "environment", sharedKey: "API", whole: true },
    { key: "D", level: "server", sharedKey: "HOST", whole: false },
  ]);
});

// Dokploy also writes `${{ <service>.<field> }}`, which is NOT a shared variable: `envNeedsInterpolation` owns those.
test("sharedRefsIn does not claim a service reference", () => {
  const entries = parseEnvBlob("A=${{ mydb.databaseName }}");
  assert.deepEqual(sharedRefsIn(entries), []);
  assert.deepEqual(envNeedsInterpolation(entries), ["A"]);
});

test("resolveSharedRefs rewrites in place and names what it could not answer", () => {
  const entries = parseEnvBlob(
    "A=${{project.DB_URL}}\nB=pre-{{team.X}}-post\nC={{team.MISSING}}\nD=plain",
  );
  const r = resolveSharedRefs(
    entries,
    new Map([
      ["DB_URL", "postgres://here"],
      ["X", "mid"],
    ]),
  );
  assert.deepEqual(entries, [
    { key: "A", value: "postgres://here" },
    { key: "B", value: "pre-mid-post" },
    { key: "C", value: "{{team.MISSING}}" },
    { key: "D", value: "plain" },
  ]);
  assert.deepEqual(r.resolved, ["A", "B"]);
  assert.deepEqual(r.unresolved, ["C"]);
});

test("envNeedsInterpolation flags Dokploy's own template syntax", () => {
  const entries = parseEnvBlob("A=${{project.SHARED}}\nB=literal");
  assert.deepEqual(envNeedsInterpolation(entries), ["A"]);
});

// The number one cause of "my app does not start after the migration": the database answers to a new name, the strings spell the old.
test("renameDatabaseHosts rewrites a host token and names the keys", () => {
  const env = [
    {
      key: "DATABASE_URL",
      value: "postgres://u:p@b2-pg-public-8hleda:5432/pubdb",
    },
    { key: "REDIS_HOST", value: "b2-redis-9xk" },
    { key: "ALLOWED", value: "b2-pg-public-8hleda,localhost" },
    { key: "UNRELATED", value: "b2-pg-public-8hleda-backup" },
  ];
  const touched = renameDatabaseHosts(
    env,
    new Map([
      ["b2-pg-public-8hleda", "db-b2-pg-public"],
      ["b2-redis-9xk", "db-b2-redis"],
    ]),
  );
  assert.deepEqual(touched, ["DATABASE_URL", "REDIS_HOST", "ALLOWED"]);
  assert.equal(env[0].value, "postgres://u:p@db-b2-pg-public:5432/pubdb");
  assert.equal(env[1].value, "db-b2-redis");
  assert.equal(env[2].value, "db-b2-pg-public,localhost");
  assert.equal(
    env[3].value,
    "b2-pg-public-8hleda-backup",
    "a longer name that merely starts with it is a different host",
  );
});

test("a bare word is never swapped inside a value", () => {
  const env = [{ key: "DB_ENGINE", value: "postgres" }];
  assert.deepEqual(
    renameDatabaseHosts(env, new Map([["postgres", "db-postgres"]])),
    [],
  );
  assert.equal(env[0].value, "postgres");
});
