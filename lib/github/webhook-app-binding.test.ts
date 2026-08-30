// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb, getDb } from "../db/client";
import { encryptSecret } from "../crypto";
import { deployments as deploymentsTable } from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, TEAM_B } from "../data/identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import {
  __resetQueueForTest,
  __setRunnerForTest,
} from "../deploy/deploy-queue";
import { POST } from "../../app/api/github/webhook/route";
import { runWithIdentity } from "../auth/request-context";
import { listInstallationRepos, listRepoBranches } from "./app";

/**
 * A delivery may only act on an installation of the App whose secret signed it.
 * The signature proves ONE thing - which `github_apps` row's webhook secret signed
 * this body - and the installation id is a field IN that body.
 */

let db: TestDb;
let pg: PGlite;
const T0 = "2026-01-01T00:00:00.000Z";

/** The ATTACKER's own App, in their own team. They know this secret. */
const ATTACKER_APP_NUMERIC = 111111;
const ATTACKER_SECRET = "attacker-webhook-secret";
/** The VICTIM's App + installation, in another team. */
const VICTIM_APP_NUMERIC = 222222;
const VICTIM_SECRET = "victim-webhook-secret";
const VICTIM_INSTALL_NUMERIC = 77777777;
const VICTIM_REPO = "victimorg/private-app";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // A deploy started here must never dial a host.
  __setRunnerForTest(async () => {});
});

after(async () => {
  __resetQueueForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table github_installation, github_apps restart identity cascade;
    truncate table membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: "u_victim", teamId: TEAM_A, role: "owner" },
      { id: "u_attacker", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db, "srv_1");

  const enc = (v: string) => encryptSecret(v).replace(/'/g, "''");
  await pg.exec(`
    insert into github_apps (id, team_id, app_id, slug, name, client_id, client_secret_enc, webhook_secret_enc, private_key_enc, html_url, created_at)
      values ('gha_attacker','${TEAM_B}',${ATTACKER_APP_NUMERIC},'atk','atk','cid1','${enc("cs")}','${enc(ATTACKER_SECRET)}','${enc("pk")}','https://x','${T0}');
    insert into github_apps (id, team_id, app_id, slug, name, client_id, client_secret_enc, webhook_secret_enc, private_key_enc, html_url, created_at)
      values ('gha_victim','${TEAM_A}',${VICTIM_APP_NUMERIC},'vic','vic','cid2','${enc("cs")}','${enc(VICTIM_SECRET)}','${enc("pk")}','https://x','${T0}');
    insert into github_installation (id, app_id, installation_id, account_login, account_type, avatar_url, created_at)
      values ('ghi_victim','gha_victim',${VICTIM_INSTALL_NUMERIC},'victimorg','Organization','','${T0}');
  `);

  await seedApp(db, {
    id: "prj_victim",
    teamId: TEAM_A,
    slug: "victim",
    serverId: "srv_1",
    source: "github",
  });
  await pg.exec(`
    update apps set auto_deploy = true,
                    repo_installation_id = 'ghi_victim',
                    repo_repo = '${VICTIM_REPO}',
                    repo_branch = 'main',
                    repo_trigger_type = 'push'
      where id = 'prj_victim';
  `);
});

/** A push delivery for the victim's repo + installation, signed with `secret`
 *  and announced as coming from the App numbered `targetAppId`. */
function pushDelivery(secret: string, targetAppId: number): Request {
  const body = JSON.stringify({
    ref: "refs/heads/main",
    repository: { full_name: VICTIM_REPO },
    installation: { id: VICTIM_INSTALL_NUMERIC },
    pusher: { name: "someone" },
    head_commit: { message: "push" },
  });
  return new Request("https://deplo.test/api/github/webhook", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-hook-installation-target-id": String(targetAppId),
      "x-hub-signature-256":
        "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      "x-github-event": "push",
    },
  });
}

const deployments = () => getDb().select().from(deploymentsTable);

test("a delivery signed by another App triggers nothing on this installation", async () => {
  const res = await POST(pushDelivery(ATTACKER_SECRET, ATTACKER_APP_NUMERIC));
  // Acknowledged, like every other delivery Deplo cannot act on - a 4xx here
  // would tell the caller their guess about the installation id was right.
  assert.equal(res.status, 200);
  assert.deepEqual(await deployments(), []);
});

test("the App's OWN installation still deploys", async () => {
  const res = await POST(pushDelivery(VICTIM_SECRET, VICTIM_APP_NUMERIC));
  assert.equal(res.status, 200);
  const rows = await deployments();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].appId, "prj_victim");
});

/**
 * `githubRepos`/`githubBranches` are `loggedIn`-only (a member picks a repo with
 * no capability), so the team check has to live in the data layer.
 */
test("listing repos/branches refuses another team's installation id (IDOR)", async () => {
  await runWithIdentity({ userId: "u_attacker", teamId: TEAM_B }, async () => {
    await assert.rejects(
      () => listInstallationRepos("ghi_victim"),
      /installation not found/i,
    );
    await assert.rejects(
      () => listRepoBranches("ghi_victim", "victimorg/private-app"),
      /installation not found/i,
    );
  });
  // The owning team gets PAST the team check - it fails later on the real GitHub
  // call (an invalid test private key), NOT with "installation not found".
  await runWithIdentity({ userId: "u_victim", teamId: TEAM_A }, async () => {
    await assert.rejects(
      () => listInstallationRepos("ghi_victim"),
      (e: Error) => !/installation not found/i.test(e.message),
    );
  });
});

test("a body signed with the wrong secret is still a 401", async () => {
  const res = await POST(pushDelivery(ATTACKER_SECRET, VICTIM_APP_NUMERIC));
  assert.equal(res.status, 401);
  assert.deepEqual(await deployments(), []);
});
