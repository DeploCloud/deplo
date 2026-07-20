import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  activities as activitiesTable,
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  TRUNCATE_INFRA,
  seedActivity,
  seedGithubApp,
  seedGithubInstallation,
  seedServerRow,
} from "./infra-test-helpers";
import {
  getServer,
  getServerById,
  listServers,
  markServerSeen,
  observedTraefik,
} from "./servers";
import {
  listGithubApps,
  listGithubInstallations,
  upsertInstallation,
  removeGithubApp,
} from "./github";
import { recordActivity, listActivity, listActivityByActor } from "./activity";

/**
 * Data-layer tests for the infra / integrations cut-set (e) against pglite
 * (relational-store PLAN Step 6): `servers`, `github_apps`(+`github_installation`),
 * `activities`. Verifies the relational reads/writes, the github installation
 * upsert idempotency + cross-tenant guard + app-delete cascade, the
 * `markServerSeen` best-effort heartbeat (incl. the unprovisioned-server guard),
 * and the activity `seq`-ordered list + relational team resolution.
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

const T0 = "2026-01-01T00:00:00.000Z";

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_INFRA}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/* ------------------------------------------------------------------ */
/* servers                                                             */
/* ------------------------------------------------------------------ */

test("servers: listServers is creation-ordered; assembleServer rebuilds agent/bootstrap", async () => {
  await seedServerRow(db, {
    id: "srv_b",
    createdAt: "2026-02-02T00:00:00.000Z",
    agent: { port: 9443, certFingerprint: "fp", certPem: "pem", version: "1.0" },
  });
  await seedServerRow(db, {
    id: "srv_a",
    createdAt: "2026-01-01T00:00:00.000Z",
    bootstrap: { tokenHash: "th", expiresAt: "2099-01-01T00:00:00.000Z", usedAt: null },
  });
  await asUser1(async () => {
    const list = await listServers();
    assert.deepEqual(
      list.map((s) => s.id),
      ["srv_a", "srv_b"],
      "by createdAt ascending",
    );
    // srv_a was seeded with a bootstrap (provisioning) and no agent.
    const a = list.find((s) => s.id === "srv_a")!;
    assert.equal(a.agent, undefined);
    assert.equal(a.bootstrap?.tokenHash, "th");
    assert.equal(a.bootstrap?.usedAt, null);
    // srv_b was seeded provisioned (agent present, no bootstrap).
    const b = list.find((s) => s.id === "srv_b")!;
    assert.equal(b.agent?.certFingerprint, "fp");
    assert.equal(b.agent?.version, "1.0");
    assert.equal(b.bootstrap, undefined);
  });
});

test("servers: getServer returns null for an unknown id", async () => {
  await asUser1(async () => {
    assert.equal(await getServer("nope"), null);
  });
});

test("servers: markServerSeen updates lastSeenAt + traefik, and pins version only when provisioned", async () => {
  await seedServerRow(db, {
    id: "srv_prov",
    traefikEnabled: false,
    agent: { port: 9443, certFingerprint: "fp", certPem: "p", version: "1.0" },
  });
  await seedServerRow(db, { id: "srv_unprov", traefikEnabled: false }); // no agent

  await markServerSeen("srv_prov", "2.0", true);
  await markServerSeen("srv_unprov", "9.9", true);

  const prov = (await getServerById("srv_prov"))!;
  assert.equal(prov.agent?.version, "2.0", "provisioned server takes the new version");
  assert.equal(prov.traefikEnabled, true);
  assert.notEqual(prov.lastSeenAt, undefined);

  const unprov = (await getServerById("srv_unprov"))!;
  assert.equal(unprov.agent, undefined, "unprovisioned server stays agent-less");
  assert.equal(unprov.traefikEnabled, true, "traefik flag still updates");
});

test("servers: observedTraefik reports nothing when the Hello never looked", () => {
  assert.equal(observedTraefik({ dockerAvailable: true, traefikRunning: true }), true);
  assert.equal(observedTraefik({ dockerAvailable: true, traefikRunning: false }), false);
  // The agent FORCES traefikRunning false when Docker is unreachable — it has no
  // container list to match against. That is "we didn't look", not "it's off".
  assert.equal(
    observedTraefik({ dockerAvailable: false, traefikRunning: false }),
    undefined,
    "Docker down means unobserved, never a false verdict",
  );
});

test("servers: markServerSeen keeps the last-known traefik flag when nothing was observed", async () => {
  await seedServerRow(db, {
    id: "srv_dockerless",
    traefikEnabled: true,
    agent: { port: 9443, certFingerprint: "fp", certPem: "p", version: "1.0" },
  });

  // A Hello that reached the agent but not Docker. Writing its forced-false through
  // would flip a good badge to "off" for a question nobody actually asked.
  await markServerSeen(
    "srv_dockerless",
    "2.0",
    observedTraefik({ dockerAvailable: false, traefikRunning: false }),
  );

  const row = (await getServerById("srv_dockerless"))!;
  assert.equal(row.traefikEnabled, true, "unobserved leaves the stored flag alone");
  assert.equal(row.agent?.version, "2.0", "the rest of the heartbeat still lands");
});

test("servers: markServerSeen swallows an unknown id (best-effort)", async () => {
  // No throw, no row touched.
  await markServerSeen("ghost", "1.0", true);
  const rows = await db.select().from(serversTable);
  assert.equal(rows.length, 0);
});

/* ------------------------------------------------------------------ */
/* github                                                              */
/* ------------------------------------------------------------------ */

test("github: listGithubApps is team-scoped and folds in installations (no secrets)", async () => {
  await seedGithubApp(db, { id: "gha_a", teamId: TEAM_A, appId: 1, name: "AppA" });
  await seedGithubApp(db, { id: "gha_b", teamId: TEAM_B, appId: 2, name: "AppB" });
  await seedGithubInstallation(db, { id: "ghi_1", appId: "gha_a", installationId: 11 });

  await asUser1(async () => {
    const apps = await listGithubApps();
    assert.equal(apps.length, 1, "only the active team's app");
    assert.equal(apps[0]!.id, "gha_a");
    assert.equal(apps[0]!.installations.length, 1);
    assert.equal(apps[0]!.installations[0]!.installationId, 11);
    // The DTO never leaks the secrets.
    assert.equal("clientSecretEnc" in apps[0]!, false);
    assert.equal("privateKeyEnc" in apps[0]!, false);

    const installs = await listGithubInstallations();
    assert.equal(installs.length, 1);
    assert.equal(installs[0]!.id, "ghi_1");
  });
});

test("github: upsertInstallation is idempotent on the numeric id and keeps created_at", async () => {
  await seedGithubApp(db, { id: "gha_a", teamId: TEAM_A });
  await asUser1(async () => {
    const first = await upsertInstallation({
      appDbId: "gha_a",
      installationId: 77,
      accountLogin: "octo",
      accountType: "User",
      avatarUrl: "u1",
    });
    const second = await upsertInstallation({
      appDbId: "gha_a",
      installationId: 77,
      accountLogin: "octo-renamed",
      accountType: "Organization",
      avatarUrl: "u2",
    });
    // Same row (one installation per numeric id), refreshed fields.
    assert.equal(second.id, first.id);
    assert.equal(second.accountLogin, "octo-renamed");
    assert.equal(second.accountType, "Organization");
    assert.equal(second.createdAt, first.createdAt, "created_at untouched on conflict");
  });
  const rows = await db.select().from(githubInstallationTable);
  assert.equal(rows.length, 1, "still exactly one installation row");
});

test("github: upsertInstallation refuses an app owned by another team (cross-tenant)", async () => {
  await seedGithubApp(db, { id: "gha_b", teamId: TEAM_B });
  await asUser1(async () => {
    await assert.rejects(
      upsertInstallation({
        appDbId: "gha_b",
        installationId: 5,
        accountLogin: "x",
        accountType: "User",
        avatarUrl: "",
      }),
      /not found/,
    );
  });
});

test("github: removeGithubApp cascades its installations in one delete", async () => {
  await seedGithubApp(db, { id: "gha_a", teamId: TEAM_A });
  await seedGithubInstallation(db, { id: "ghi_1", appId: "gha_a", installationId: 1 });
  await seedGithubInstallation(db, { id: "ghi_2", appId: "gha_a", installationId: 2 });
  await asUser1(async () => {
    await removeGithubApp("gha_a");
  });
  assert.equal((await db.select().from(githubAppsTable)).length, 0);
  assert.equal(
    (await db.select().from(githubInstallationTable)).length,
    0,
    "installations cascade-deleted with the app",
  );
});

/* ------------------------------------------------------------------ */
/* activities                                                          */
/* ------------------------------------------------------------------ */

test("activities: recordActivity writes a relational row resolved to the explicit team", async () => {
  await asUser1(async () => {
    await recordActivity("member", "did X", "owner", null, TEAM_A);
    const list = await listActivity();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.message, "did X");
    assert.equal(list[0]!.teamId, TEAM_A);
  });
});

test("activities: recordActivity falls back to the first team when none resolves", async () => {
  await asUser1(async () => {
    await recordActivity("member", "no-team event", "owner", null, null);
  });
  const rows = await db.select().from(activitiesTable);
  assert.equal(rows.length, 1);
  // The first team by createdAt — seedIdentity seeds team_a before team_b.
  assert.equal(rows[0]!.teamId, TEAM_A);
});

test("activities: listActivity is team-scoped, newest-first, and seq breaks a same-instant tie", async () => {
  // Three activities at the SAME timestamp in team_a — insertion order (seq) must
  // break the tie deterministically, newest (last inserted) first.
  await seedActivity(db, { id: "act_1", teamId: TEAM_A, createdAt: T0, message: "first" });
  await seedActivity(db, { id: "act_2", teamId: TEAM_A, createdAt: T0, message: "second" });
  await seedActivity(db, { id: "act_3", teamId: TEAM_A, createdAt: T0, message: "third" });
  // A different team's activity must not appear.
  await seedActivity(db, { id: "act_b", teamId: TEAM_B, createdAt: T0, message: "other team" });

  await asUser1(async () => {
    const list = await listActivity();
    assert.deepEqual(
      list.map((a) => a.id),
      ["act_3", "act_2", "act_1"],
      "newest-first by (createdAt DESC, seq DESC)",
    );
  });
});

test("activities: listActivityByActor filters by actor across teams", async () => {
  await seedActivity(db, { id: "a1", teamId: TEAM_A, actor: "alice", createdAt: "2026-01-01T00:00:00.000Z" });
  await seedActivity(db, { id: "a2", teamId: TEAM_B, actor: "alice", createdAt: "2026-01-02T00:00:00.000Z" });
  await seedActivity(db, { id: "a3", teamId: TEAM_A, actor: "bob", createdAt: "2026-01-03T00:00:00.000Z" });

  const alice = await listActivityByActor("alice", 10);
  assert.deepEqual(
    alice.map((a) => a.id),
    ["a2", "a1"],
    "alice's events across teams, newest-first",
  );
});

