import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { decryptSecret } from "../crypto";
import {
  envVars as envVarsTable,
  appPreviewEnvVars as previewEnvVarsTable,
} from "../db/schema/control-plane";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
  USER_1,
} from "./identity-test-helpers";
import { importEnv, listEnv, renameEnv, setAppEnv, upsertEnv } from "./env";
import { listInstanceEnv, upsertInstanceEnv } from "./global-env";
import { listSharedVars, saveSharedVar } from "./shared-vars";
import { listPreviewEnvVars, setPreviewEnvVar } from "./previews";

/**
 * A SECRET variable is write-only AND immutable, on every env layer. So: create
 * it, delete it, never edit it. `plain` -> `secret` stays open, because hardening
 * is never the thing you gate.
 */

let db: TestDb;
let pg: PGlite;

const APP = "prj_1";
const MASK = "••••••••••••";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}${TRUNCATE_IDENTITY}
    truncate table instance_env_vars, shared_env_vars restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A, status: "active" });
});

const as1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** The stored ciphertext, so a test can prove the value survived a refusal. */
async function storedValue(key: string): Promise<string> {
  const [row] = await db
    .select({ valueEnc: envVarsTable.valueEnc })
    .from(envVarsTable)
    .where(and(eq(envVarsTable.appId, APP), eq(envVarsTable.key, key)));
  return decryptSecret(row!.valueEnc);
}

const seedSecret = (key = "API_KEY", value = "s3cr3t") =>
  as1(() => upsertEnv({ appId: APP, key, value, type: "secret" }));

/* ------------------------------------------------------------------ */
/* The app's own variables                                             */
/* ------------------------------------------------------------------ */

test("upsertEnv refuses to edit a secret, and the value survives the refusal", async () => {
  await seedSecret();
  for (const attempt of [
    { value: MASK, type: "plain" as const }, // the downgrade
    { value: MASK, type: "secret" as const }, // a targets-only save
    { value: "rotated", type: "secret" as const }, // an honest rotation
  ]) {
    await assert.rejects(
      () => as1(() => upsertEnv({ appId: APP, key: "API_KEY", ...attempt })),
      /cannot be edited/i,
      JSON.stringify(attempt),
    );
  }
  const [row] = await as1(() => listEnv(APP));
  assert.equal(row!.type, "secret");
  assert.equal(row!.masked, true);
  assert.notEqual(row!.value, "s3cr3t");
  assert.equal(await storedValue("API_KEY"), "s3cr3t");
});

test("upsertEnv still PROMOTES a plain var to secret", async () => {
  await as1(() =>
    upsertEnv({ appId: APP, key: "TOKEN", value: "v1", type: "plain" }),
  );
  // Editing a plain var is ordinary work, including hardening it.
  await as1(() =>
    upsertEnv({ appId: APP, key: "TOKEN", value: "v2", type: "plain" }),
  );
  await as1(() =>
    upsertEnv({ appId: APP, key: "TOKEN", value: "v2", type: "secret" }),
  );
  const [row] = await as1(() => listEnv(APP));
  assert.equal(row!.type, "secret");
  assert.equal(row!.masked, true);
  assert.equal(await storedValue("TOKEN"), "v2");
  // And the ratchet only turns one way.
  await assert.rejects(
    () =>
      as1(() =>
        upsertEnv({ appId: APP, key: "TOKEN", value: MASK, type: "plain" }),
      ),
    /cannot be edited/i,
  );
});

test("renameEnv refuses on a secret — a frozen row is frozen in its key too", async () => {
  await seedSecret();
  const [row] = await as1(() => listEnv(APP));
  await assert.rejects(
    () => as1(() => renameEnv(row!.id, "OTHER_NAME")),
    /cannot be edited/i,
  );
  assert.equal((await as1(() => listEnv(APP)))[0]!.key, "API_KEY");
});

test("importEnv skips a key that is already a secret, and counts it", async () => {
  await seedSecret();
  const res = await as1(() =>
    importEnv(APP, "API_KEY=leaked\nPORT=3000\nDEBUG=1"),
  );
  assert.deepEqual(res, { added: 2, skippedSecrets: 1 });
  const list = await as1(() => listEnv(APP));
  assert.deepEqual(list.map((v) => v.key).sort(), ["API_KEY", "DEBUG", "PORT"]);
  const secret = list.find((v) => v.key === "API_KEY")!;
  assert.equal(secret.type, "secret", "not downgraded by the import");
  assert.equal(
    await storedValue("API_KEY"),
    "s3cr3t",
    "not overwritten either",
  );
});

test("setAppEnv leaves a secret alone whatever value arrives", async () => {
  await seedSecret();
  await as1(() =>
    setAppEnv(APP, [
      { key: "API_KEY", value: "typed-over" },
      { key: "PORT", value: "3000" },
    ]),
  );
  assert.equal(await storedValue("API_KEY"), "s3cr3t");
  assert.equal(
    (await as1(() => listEnv(APP))).find((v) => v.key === "API_KEY")!.type,
    "secret",
  );
});

/* ------------------------------------------------------------------ */
/* Shared variables — frozen value, but re-sharable                    */
/* ------------------------------------------------------------------ */

const sharedSecret = () =>
  as1(() =>
    saveSharedVar({
      key: "STRIPE_KEY",
      value: "sk_live",
      type: "secret",
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    }),
  );

test("saveSharedVar refuses a value, key or type change on a secret", async () => {
  const id = await sharedSecret();
  const base = {
    id,
    key: "STRIPE_KEY",
    value: MASK,
    type: "secret" as const,
    teamWide: true,
    environmentIds: [],
    projectIds: [],
  };
  for (const attempt of [
    { ...base, type: "plain" as const }, // the downgrade
    { ...base, value: "sk_live_attacker" }, // an overwrite
    { ...base, key: "RENAMED" }, // a rename
  ]) {
    await assert.rejects(
      () => as1(() => saveSharedVar(attempt)),
      /cannot be edited/i,
      JSON.stringify({
        type: attempt.type,
        value: attempt.value,
        key: attempt.key,
      }),
    );
  }
  const [v] = await as1(() => listSharedVars());
  assert.equal(v!.key, "STRIPE_KEY");
  assert.equal(v!.type, "secret");
  assert.notEqual(v!.value, "sk_live");
});

test("but a secret can still be RE-SHARED — that never exposes it", async () => {
  // Changing who receives a secret neither reads it back nor could ever expose
  // it, and forbidding it would mean deleting and retyping a credential every
  // time a new app needs one.
  const id = await sharedSecret();
  await as1(() =>
    saveSharedVar({
      id,
      key: "STRIPE_KEY",
      value: MASK,
      type: "secret",
      teamWide: false,
      environmentIds: [],
      projectIds: [],
      appIds: [APP],
    }),
  );
  const [v] = await as1(() => listSharedVars());
  assert.equal(v!.teamWide, false, "the sharing DID change");
  assert.deepEqual(v!.appIds, [APP]);
  assert.equal(v!.type, "secret");
  assert.equal(v!.masked, true);
});

/* ------------------------------------------------------------------ */
/* Instance-wide and preview overrides                                 */
/* ------------------------------------------------------------------ */

test("upsertInstanceEnv refuses to edit a secret", async () => {
  await as1(() =>
    upsertInstanceEnv({ key: "GLOBAL", value: "g", type: "secret" }),
  );
  await assert.rejects(
    () =>
      as1(() =>
        upsertInstanceEnv({ key: "GLOBAL", value: MASK, type: "plain" }),
      ),
    /cannot be edited/i,
  );
  const [v] = await as1(() => listInstanceEnv());
  assert.equal(v!.type, "secret");
  assert.equal(v!.masked, true);
});

test("setPreviewEnvVar refuses to overwrite a secret override", async () => {
  await as1(() => setPreviewEnvVar(APP, "PREVIEW_KEY", "p", "secret"));
  // The upsert here was blind and its `type` defaults to plain, so re-adding the
  // key downgraded the row — which also strips the filter that keeps a secret out
  // of a FORK's preview container.
  await assert.rejects(
    () => as1(() => setPreviewEnvVar(APP, "PREVIEW_KEY", "leaked")),
    /cannot be edited/i,
  );
  assert.deepEqual(
    (await as1(() => listPreviewEnvVars(APP))).map((v) => v.type),
    ["secret"],
  );
  const [row] = await db
    .select({ valueEnc: previewEnvVarsTable.valueEnc })
    .from(previewEnvVarsTable)
    .where(eq(previewEnvVarsTable.appId, APP));
  assert.equal(decryptSecret(row!.valueEnc), "p");
});
