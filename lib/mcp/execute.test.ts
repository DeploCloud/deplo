import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/leaf-test-helpers";
import { runWithIdentity } from "../auth/request-context";
import { authenticateToken } from "../data/tokens/authenticate";
import { createToken } from "../data/tokens/mint";
import { getCurrentUser } from "../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { getNamedType, isObjectType } from "graphql";
import { admitPassthrough, deniedRootFields, runGraphql } from "./execute";
import { schema } from "../graphql/schema";
import { MCP_TOOLS } from "./tools/catalog";

let db: TestDb;
let pg: PGlite;

const TRUNCATE = `truncate table api_tokens, users, teams restart identity cascade;`;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db);
});

async function contextFor(
  capabilities: Parameters<typeof createToken>[0]["capabilities"],
) {
  const raw = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    createToken({ name: "mcp", capabilities }),
  );
  const identity = await authenticateToken(raw.raw, null);
  assert.ok(identity, "the freshly minted token must authenticate");
  return runWithIdentity(identity, async () => ({
    viewer: await getCurrentUser(),
    teamId: await getActiveTeamId(),
    capabilities: await reachableCapabilities(),
    via: "token" as const,
    identity,
  }));
}

test("a tool's document resolves as the token, in the token's team", async () => {
  const ctx = await contextFor(["view"]);
  const whoami = MCP_TOOLS.find((t) => t.name === "whoami")!;

  const { data, error } = await runGraphql(whoami.query, {}, ctx);
  assert.equal(error, undefined, error ?? "");

  const result = data as {
    apiContext: { via: string; teamId: string };
    me: { id: string } | null;
    viewerTeam: { id: string };
  };
  assert.equal(
    result.apiContext.via,
    "token",
    "the request must read as token auth",
  );
  assert.equal(result.apiContext.teamId, TEAM_A);
  assert.equal(result.me?.id, USER_1, "resolved as the token's creator");
  assert.equal(result.viewerTeam.id, TEAM_A);
});

test("a capability the token was not granted is refused, not silently allowed", async () => {
  const ctx = await contextFor(["view"]);
  const del = MCP_TOOLS.find((t) => t.name === "delete_app")!;

  const { data, error } = await runGraphql(del.query, { id: "prj_nope" }, ctx);
  assert.ok(
    error || (data as { deleteApp?: unknown } | null)?.deleteApp !== true,
    "deleting an app with a view-only token must not succeed",
  );
});

test("the team hint decides which team a document resolves in", async () => {
  const raw = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    createToken({ name: "mcp", capabilities: ["view"] }),
  );
  const identity = await authenticateToken(raw.raw, TEAM_B);
  assert.ok(identity);
  assert.equal(
    identity.teamId,
    TEAM_A,
    "an unreachable hint falls back, never through",
  );
});

const refusal = (query: string, kind: "query" | "mutation" = "query") => {
  try {
    admitPassthrough(query, kind);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

test("the passthrough refuses every field that hands back a credential", () => {
  for (const field of deniedRootFields()) {
    const root =
      schema.getMutationType()!.getFields()[field] ??
      schema.getQueryType()!.getFields()[field];
    assert.ok(root, `${field} is not a root field any more - stale entry`);
    const kind = schema.getMutationType()!.getFields()[field]
      ? "mutation"
      : "query";
    const message = refusal(`${kind} X { ${field} }`, kind);
    assert.match(
      message,
      /cannot be run over MCP/,
      `${field} was admitted: ${message || "no error"}`,
    );
  }
});

test("a root is refused for what it returns, whatever its name", () => {
  for (const name of [
    "addServer",
    "reissueServerBootstrap",
    "createToken",
    "migrationSession",
    "importMigrationMembers",
    "mintRegistrationLink",
    "rotateDatabasePassword",
    "destinationRecoveryKey",
    "startTwoFactorEnrolment",
  ])
    assert.ok(deniedRootFields().has(name), `${name} is not denied`);
  assert.match(
    refusal(
      `mutation { addServer(input: { name: "a", host: "b" }) { installCommand } }`,
      "mutation",
    ),
    /cannot be run over MCP/,
  );
});

// Reviewed: each matches the pattern below and carries no credential.
const NOT_A_CREDENTIAL = new Set([
  "AppSharedVar.key",
  "AppTransferInfo.gitConnectionLabel",
  "BackupDestination.accessKeyMasked",
  "BackupDestination.recoveryKeySavedAt",
  "BackupDestinationOption.recoveryKeySavedAt",
  "BackupRun.objectKey",
  "CronJob.command",
  "CronJob.envKeys",
  "CronRun.command",
  "Database.connectionStringMasked",
  "Database.customCommand",
  "Deployment.deployKey",
  "EnvVar.key",
  "GitConnection.tokenExpiresAt",
  "GitProvider.tokenHelpUrl",
  "GitProvider.tokenScopes",
  "HealthCheck.command",
  "Mutation.saveNotificationChannel",
  "PreviewEnvVar.key",
  "Query.agentUninstallCommand",
  "Query.apiContext",
  "Query.notificationChannels",
  "Query.webPushPublicKey",
  "RecognizedFramework.buildCommand",
  "RecognizedFramework.startCommand",
  "RegistrationLink.linkMasked",
  "S3TestReport.command",
  "S3TestStep.key",
  "ServerRemoval.uninstallCommand",
  "ServerUninstall.uninstallCommand",
  "SharedVar.key",
]);

function outputFields() {
  return Object.values(schema.getTypeMap())
    .filter(isObjectType)
    .filter((t) => !t.name.startsWith("__"))
    .flatMap((t) =>
      Object.values(t.getFields()).map((field) => ({ type: t, field })),
    );
}

test("every field that could carry a credential is marked, or reviewed as not one", () => {
  const looks =
    /secret|token|passw|credential|key|code|link|command|identity|^raw$|uri$|connection|hook|setup/i;
  const says = /decrypt|single-use|shown once|credential/i;
  const roots = [schema.getQueryType(), schema.getMutationType()];
  const unmarked = outputFields()
    .filter(({ type, field }) => {
      const scalar = getNamedType(field.type).name;
      if (scalar !== "String" && scalar !== "JSON") return false;
      if (field.extensions.credential === true) return false;
      if (NOT_A_CREDENTIAL.has(`${type.name}.${field.name}`)) return false;
      if (roots.includes(type) && deniedRootFields().has(field.name))
        return false;
      return (
        scalar === "JSON" ||
        looks.test(field.name) ||
        says.test(field.description ?? "")
      );
    })
    .map(({ type, field }) => `${type.name}.${field.name}`);
  assert.deepEqual(
    unmarked,
    [],
    "Mark a field that can hold a credential with `extensions: { credential: true }`, so MCP refuses every root returning it; otherwise add it to NOT_A_CREDENTIAL.",
  );
});

test("NOT_A_CREDENTIAL names only fields that still exist", () => {
  const live = new Set(
    outputFields().map(({ type, field }) => `${type.name}.${field.name}`),
  );
  for (const coord of NOT_A_CREDENTIAL)
    assert.ok(live.has(coord), `${coord} is gone - drop it from the list`);
});

test("every reveal* root field is denied without being listed by hand", () => {
  const reveals = [
    ...Object.keys(schema.getQueryType()!.getFields()),
    ...Object.keys(schema.getMutationType()!.getFields()),
  ].filter((n) => /^reveal[A-Z]/.test(n));
  assert.ok(reveals.length > 0, "the schema has no reveal* fields to derive");
  for (const name of reveals)
    assert.ok(deniedRootFields().has(name), `${name} is not denied`);
});

test("a denied field is refused from inside a fragment too", () => {
  const message = refusal(
    `mutation X { ...F } fragment F on Mutation { revealRegistrationLink }`,
    "mutation",
  );
  assert.match(message, /cannot be run over MCP/);
});

test("a field that merely shares a denied name is not refused", () => {
  const guard = deniedRootFields();
  assert.ok(guard.has("login"));
  assert.equal(refusal(`query X { apps { id slug } }`), "");
});

test("graphql_query refuses a mutation, and graphql_mutate refuses a query", () => {
  assert.match(
    refusal(`mutation M { deleteApp(id: "x") }`, "query"),
    /runs query operations only/,
  );
  assert.match(
    refusal(`query Q { apps { id } }`, "mutation"),
    /runs mutation operations only/,
  );
});

test("a subscription is refused, whichever passthrough it arrives at", () => {
  assert.match(
    refusal(`subscription S { activeDeployments }`, "query"),
    /Subscriptions cannot be run over MCP/,
  );
});

test("a second operation cannot ride along behind the first", () => {
  assert.match(
    refusal(`query A { apps { id } } mutation B { deleteApp(id: "x") }`),
    /runs query operations only/,
  );
});

test("the passthrough carries /api/graphql's own depth limit", () => {
  let q = "id";
  for (let i = 0; i < 16; i++) q = `apps { ${q} }`;
  assert.match(refusal(`query Deep { ${q} }`), /depth|Cannot query field/i);
});

test("an unknown field is a refusal, not a silently empty answer", () => {
  assert.match(refusal(`query X { apps { naem } }`), /Cannot query field/);
});

test("a driver error reaches the model masked, exactly as it reaches /api/graphql", async () => {
  const ctx = await contextFor(["view"]);
  const res = await runGraphql(
    'query { app(slug: "a\u0000b") { id } }',
    {},
    ctx,
  );
  assert.ok(res.error, "the failure is reported");
  assert.doesNotMatch(res.error!, /Failed query|select |params/i);
  assert.equal(res.error, "Something went wrong");
});
