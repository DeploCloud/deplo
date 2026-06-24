import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { buildSeed } from "../seed";
import {
  defaultNotificationSettings,
  type DeploData,
  type NotificationSettings,
} from "../types";
import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runBackfill } from "../db/backfill/engine";
import { leafCutSetCopy } from "../db/backfill/cut-sets/leaf";
import { identityCutSetCopy } from "../db/backfill/cut-sets/identity";
import { CUT_SETS } from "../db/backfill/markers";
import { runWithIdentity } from "../auth/request-context";
import { capabilitiesForRole } from "../membership-shared";
import * as store from "../store";
import { listTokens } from "./tokens";
import { listRegistries } from "./registries";
import { getNotificationSettings } from "./notifications";

/**
 * End-to-end: the leaf BACKFILL (copy from a live JSONB doc into the relational
 * tables) and the new async DATA LAYER agree (relational-store PLAN Step 2
 * "backfill fidelity"). We seed a `DeploData`, run the leaf cut-set's backfill
 * against pglite, then read it back through the LIVE data functions — proving the
 * copy lands in exactly the rows/shape the async reads expect.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    truncate table api_tokens, registries, installed_apps,
      notification_settings, store_migration, users, teams restart identity cascade;
  `);
});

const TEAM = "team_a";
const USER = "user_1";
const T0 = "2026-01-01T00:00:00.000Z";

function customSettings(): NotificationSettings {
  const s = defaultNotificationSettings();
  return {
    channels: {
      push: { enabled: true },
      email: { enabled: true, address: "alerts@alpha.io" },
      discord: { enabled: false, webhookUrl: "" },
      webhook: { enabled: true, url: "https://hook.alpha.io" },
    },
    events: { ...s.events, deployment_succeeded: true },
  };
}

/** A JSONB doc the backfill will copy from. */
function doc(): DeploData {
  const d = buildSeed();
  d.teams = [{ id: TEAM, name: "Alpha", slug: "alpha", plan: "pro", createdAt: T0 }];
  d.users = [
    {
      id: USER, email: "owner@alpha.io", username: "owner", name: "Owner",
      passwordHash: "h", role: "owner", isInstanceAdmin: true,
      avatarColor: "#abc", createdAt: T0,
    },
  ];
  d.memberships = [
    {
      id: "mem_1", userId: USER, teamId: TEAM, role: "owner",
      capabilities: capabilitiesForRole("owner"), createdAt: T0,
    },
  ];
  d.apiTokens = [
    {
      id: "tok_1", teamId: TEAM, userId: USER, name: "CI",
      tokenHash: "hash_ci", prefix: "deplo_ci", lastUsedAt: null, createdAt: "2026-02-01T00:00:00.000Z",
    },
  ];
  d.registries = [
    {
      id: "reg_1", teamId: TEAM, name: "GHCR", type: "ghcr",
      registryUrl: "ghcr.io", username: "alpha", passwordEnc: "enc_pw",
      createdAt: "2026-02-02T00:00:00.000Z",
    },
  ];
  d.notificationSettings = { [TEAM]: customSettings() };
  return d;
}

test("leaf backfill → async data layer reads back the copied rows", async () => {
  const d = doc();

  // 1) Run the cut-set backfills (copy from the JSONB doc into pglite). The leaf
  //    cut-set copies the four leaf collections; the identity cut-set (b) copies
  //    users/teams/memberships(+caps) so the authz backbone (requireActiveTeamId)
  //    resolves relationally — both are relational as of Step 3.
  await runBackfill(db, CUT_SETS.leaf, d, leafCutSetCopy);
  await runBackfill(db, CUT_SETS.identity, d, identityCutSetCopy);

  // 2) Reset the JSONB store so no stale identity lingers (identity is relational).
  store.reseed();

  // 3) Read each leaf collection through the LIVE async data functions.
  await runWithIdentity({ userId: USER, teamId: TEAM }, async () => {
    const tokens = await listTokens();
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]!.id, "tok_1");
    assert.equal(tokens[0]!.name, "CI");

    const regs = await listRegistries();
    assert.equal(regs.length, 1);
    assert.equal(regs[0]!.name, "GHCR");
    assert.equal("passwordEnc" in regs[0]!, false);

    const settings = await getNotificationSettings();
    assert.deepEqual(settings, customSettings());
  });
});
