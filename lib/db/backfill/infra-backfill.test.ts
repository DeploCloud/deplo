import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";

import { buildSeed } from "../../seed";
import type { DeploData, Server } from "../../types";
import { serverToRow } from "../../data/infra-rows";
import { makeTestDb, type TestDb } from "../test-harness";
import { __setTestDb, __resetTestDb } from "../client";
import { seedIdentity, TEAM_A, USER_1 } from "../../data/identity-test-helpers";
import { seedProject, SERVER_1 } from "../../data/project-graph-test-helpers";
import { runBackfill } from "./engine";
import { infraCutSetCopy, reconcileInfra } from "./cut-sets/infra";
import { CUT_SETS, markerExists } from "./markers";
import {
  activities as activitiesTable,
  devSshUser as devSshUserTable,
  githubInstallation as githubInstallationTable,
  invites as invitesTable,
  inviteCapabilities as inviteCapabilitiesTable,
  servers as serversTable,
} from "../schema/control-plane";

/**
 * Backfill fidelity for the infra / integrations cut-set (e) (relational-store
 * PLAN Step 6). Identity + the project graph are already relational by the time
 * cut-set (e) runs (it is last), so the FK targets (`teams`/`users`/`projects`)
 * are seeded directly via the cut-set (b)/(c) test helpers; the `DeploData` doc
 * carries only what THIS cut-set copies. Asserts: element-granular fidelity, the
 * dead-project prune (dev_ssh_user) + NULL (activities), the dangling-app
 * installation guard, the invite-capability clean, idempotent re-run, fresh-install
 * marks-done with zero rows, and rollback-on-reconcile-mismatch.
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

const TEAM = TEAM_A;
const PROJECT = "prj_live";
const T0 = "2026-01-01T00:00:00.000Z";

const TRUNCATE = `truncate table
  activities, dev_ssh_user, github_installation, github_apps,
  invite_capabilities, invites,
  team_project_order, team_folder_order,
  shared_env_group_targets, shared_env_group_projects, shared_env_group_vars, shared_env_groups,
  deployment_logs, deployments, env_var_targets, env_vars,
  domain_middlewares, domains,
  project_mounts, project_volumes, project_exposes, project_dev,
  project_build_method_settings, project_build, projects, folders, servers,
  membership_capabilities, memberships, users, teams,
  store_migration restart identity cascade;`;

beforeEach(async () => {
  await pg.exec(TRUNCATE);
  // Identity + the project graph are relational before cut-set (e) runs (it is
  // last): seed the FK targets (teams/users/project) directly via the earlier
  // cut-sets' helpers. The project's server FK is satisfied by a server seeded
  // with the SAME full agent-bearing shape the doc carries — in production the
  // project-graph cut-set bridge-seeds `servers` from the same JSONB, so cut-set
  // (e)'s `onConflictDoNothing` copy is a no-op over identical data.
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM, role: "owner" }] });
  await db.insert(serversTable).values(serverToRow(docServer()));
  await seedProject(db, { id: PROJECT, teamId: TEAM });
});

/**
 * A `DeploData` doc carrying ONLY the infra cut-set's collections. `data.projects`
 * holds just the live id set the cut-set prunes/NULLs against (the relational rows
 * are seeded separately); `data.servers` is the authoritative copy this cut-set
 * inserts. Note: `servers` is pre-seeded relationally (same id + data) by the
 * beforeEach, so the copy's `onConflictDoNothing` is a no-op over it — exactly the
 * production shape where the project-graph cut-set bridge-seeded it first.
 */
/** The full agent-bearing server the doc carries (and the beforeEach pre-seeds). */
function docServer(): Server {
  return {
    id: SERVER_1, name: "srv", host: "10.0.0.1", type: "remote", status: "online",
    ip: "10.0.0.1", dockerVersion: "27", traefikEnabled: true, cpuCores: 4, memoryMb: 8192,
    diskGb: 100, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, createdAt: T0,
    agent: { port: 9443, certFingerprint: "fp", certPem: "pem", version: "1.0" },
  };
}

function doc(): DeploData {
  const d = buildSeed();
  // The live project id set (the relational row is seeded by `seedProject`).
  d.projects = [{ id: PROJECT } as never];
  d.servers = [docServer()];
  d.invites = [
    {
      id: "inv_1", teamId: TEAM, email: "new@a.io", role: "member",
      capabilities: ["manage_env", "bogus_cap" as never], tokenHash: "th_inv",
      status: "pending", invitedBy: "Owner", expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: T0, acceptedAt: null,
    },
  ];
  d.githubApps = [
    {
      id: "gha_1", teamId: TEAM, appId: 42, slug: "deplo", name: "Deplo",
      clientId: "cid", clientSecretEnc: "cs", webhookSecretEnc: "ws", privateKeyEnc: "pk",
      htmlUrl: "https://github.com/apps/deplo", createdAt: T0,
    },
  ];
  d.githubInstallations = [
    { id: "ghi_1", appId: "gha_1", installationId: 99, accountLogin: "octo", accountType: "Organization", avatarUrl: "a", createdAt: T0 },
    // Dangling: points at a non-existent app — guarded out of the copy.
    { id: "ghi_orphan", appId: "gha_missing", installationId: 100, accountLogin: "x", accountType: "User", avatarUrl: "", createdAt: T0 },
  ];
  d.devSshUsers = [
    { id: "ssh_live", projectId: PROJECT, username: "live-dev", publicKey: "ssh-ed25519 AAAA", passwordEnc: null, createdAt: T0 },
    // Dead project (CASCADE FK) — PRUNED.
    { id: "ssh_dead", projectId: "prj_gone", username: "dead-dev", publicKey: "ssh-ed25519 BBBB", passwordEnc: null, createdAt: T0 },
  ];
  d.activities = [
    { id: "act_1", teamId: TEAM, type: "project", message: "made it", actor: "owner", projectId: PROJECT, createdAt: T0 },
    // Dead project (SET NULL FK) — projectId NULLED, row KEPT.
    { id: "act_2", teamId: TEAM, type: "project", message: "old", actor: "owner", projectId: "prj_gone", createdAt: "2026-01-02T00:00:00.000Z" },
  ];
  return d;
}

async function tableCount(
  table: typeof serversTable | typeof activitiesTable,
): Promise<number> {
  const r = await db.select({ n: count() }).from(table);
  return r[0]?.n ?? 0;
}

async function runInfra(d: DeploData): Promise<void> {
  await runBackfill(db, CUT_SETS.infra, d, infraCutSetCopy);
}

test("infra backfill copies servers/invites/github/dev_ssh/activities with fidelity", async () => {
  const d = doc();
  await runInfra(d);

  // servers: present (the copy composes over the bridge-seed via onConflictDoNothing).
  const srv = await db.select().from(serversTable).where(eq(serversTable.id, SERVER_1));
  assert.equal(srv.length, 1);
  assert.equal(srv[0]!.agentCertFingerprint, "fp");
  assert.equal(srv[0]!.agentPort, 9443);

  // invites (+ caps): cleanCapabilities drops the bogus cap and implies "view".
  const inv = await db.select().from(invitesTable);
  assert.equal(inv.length, 1);
  const caps = (await db.select().from(inviteCapabilitiesTable)).map((c) => c.capability);
  assert.ok(caps.includes("view"), "view implied");
  assert.ok(caps.includes("manage_env"), "known cap kept");
  assert.ok(!caps.includes("bogus_cap"), "unknown cap dropped");

  // github: the orphan installation (dangling app_id) is guarded out.
  const installs = await db.select().from(githubInstallationTable);
  assert.equal(installs.length, 1);
  assert.equal(installs[0]!.id, "ghi_1");

  // dev_ssh_user: dead-project row PRUNED.
  const ssh = await db.select().from(devSshUserTable);
  assert.deepEqual(ssh.map((u) => u.id), ["ssh_live"]);

  // activities: both KEPT; the dead-project one has projectId NULLED.
  const acts = await db.select().from(activitiesTable);
  assert.equal(acts.length, 2);
  const dead = acts.find((a) => a.id === "act_2")!;
  assert.equal(dead.projectId, null, "dead projectId NULLED, row kept");
  const live = acts.find((a) => a.id === "act_1")!;
  assert.equal(live.projectId, "prj_live");
});

test("infra backfill is idempotent (re-run is a no-op once the marker exists)", async () => {
  const d = doc();
  await runInfra(d);
  assert.equal(await markerExists(db, CUT_SETS.infra), true);

  // A second run sees the marker and copies nothing — counts unchanged.
  const before = await tableCount(activitiesTable);
  await runInfra(d);
  assert.equal(await tableCount(activitiesTable), before);
});

test("infra backfill on a fresh install marks done with zero rows", async () => {
  // Genuinely empty: drop the beforeEach FK seeds; the empty doc carries nothing.
  await pg.exec(TRUNCATE);
  const empty = buildSeed();
  await runInfra(empty);
  assert.equal(await markerExists(db, CUT_SETS.infra), true);
  assert.equal(await tableCount(serversTable), 0);
  assert.equal(await tableCount(activitiesTable), 0);
});

test("infra reconcile mismatch rolls back the whole copy (marker absent)", async () => {
  const d = doc();
  // A copy whose reconcile is rigged to fail: insert a phantom extra activity so
  // the element-granular count assert trips, then assert nothing committed.
  await assert.rejects(
    runBackfill(db, CUT_SETS.infra, d, async (tx, data) => {
      await infraCutSetCopy(tx, data);
      // Sabotage: add a row the reconcile didn't account for, then re-run the
      // reconcile so its count assert fails and the tx rolls back.
      await tx.insert(activitiesTable).values({
        id: "act_phantom", teamId: TEAM, type: "project", message: "x", actor: "y",
        projectId: null, createdAt: T0,
      });
      await reconcileInfra(tx, data);
    }),
    /reconcile mismatch/,
  );
  // Rolled back: no marker, no infra rows committed (invites was not pre-seeded).
  assert.equal(await markerExists(db, CUT_SETS.infra), false);
  assert.equal(await tableCount(activitiesTable), 0);
  assert.equal((await db.select().from(invitesTable)).length, 0);
});
