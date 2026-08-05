import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane";
import { eq } from "drizzle-orm";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_PROJECT_GRAPH, seedApp } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { getServerById, removeServer } from "./servers";

/**
 * Removal is TRUST REVOCATION + FORGETTING, not a host uninstall — these tests pin
 * that contract, which previously had zero coverage while the UI claimed the
 * opposite ("tells it to tear down its containers").
 *
 * What they lock:
 *   - the guards fire with a CLEAN message (a database on the server used to hit
 *     the `databases.server_id` RESTRICT FK and surface a raw Postgres error);
 *   - a BLOCKED removal has NO side effects — in particular it does not revoke
 *     trust on the way out (the old code revoked first, then blocked);
 *   - a clean removal hands back the host-side uninstall command, always;
 *   - an App mid-move OFF the server warns instead of silently stranding its
 *     volumes (`migrate_from_server_id` is SET NULL on delete).
 */

let db: TestDb;
let pg: PGlite;

const SERVER = "srv_target";
const OTHER = "srv_other";
/**
 * RFC 5737 TEST-NET-1, not the helper's default 10.0.0.1. removeServer now refuses
 * the host running Deplo, and `isDeploHostServer` classifies by comparing a row's
 * ip/host against this machine's real NIC addresses — so a private default could
 * make a removal test pass or fail depending on whose box it runs on. A TEST-NET
 * address is guaranteed never to be assigned to an interface.
 */
const REMOTE_IP = "192.0.2.10";
/** What this instance believes its OWN address is, for the Deplo-host case. */
const SELF_IP = "192.0.2.200";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // removeServer builds the uninstall one-liner from the public base URL; pin it
  // so the assertion below isn't asserting the no-request-scope placeholder.
  process.env.DEPLO_PUBLIC_URL = "https://deplo.test";
  // Pin what this instance thinks its own address is, so the Deplo-host guard is
  // testing a decision we control rather than whatever NICs the runner happens to have.
  process.env.DEPLO_SERVER_IP = SELF_IP;
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table databases, activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_member", teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await seedServerRow(db, {
    id: SERVER,
    name: "target",
    ip: REMOTE_IP,
    host: REMOTE_IP,
    agent: {
      port: 9443,
      certFingerprint: "sha256:pinned",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.0.0",
    },
  });
  await seedServerRow(db, {
    id: OTHER,
    name: "other",
    ip: "192.0.2.11",
    host: "192.0.2.11",
  });
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** The pinned agent cert of the target server, or "" once trust is revoked. */
async function pinnedCert(): Promise<string | undefined> {
  const server = await getServerById(SERVER);
  return server?.agent?.certFingerprint;
}

test("blocks removal while an App still lives on the server, naming it", async () => {
  await seedApp(db, { id: "prj_web", slug: "web", serverId: SERVER });

  await assert.rejects(
    () => asAdmin(() => removeServer(SERVER)),
    (e: Error) => {
      assert.match(e.message, /Move or delete the apps/i);
      assert.match(e.message, /web/);
      return true;
    },
  );
});

test("blocks removal while a database is hosted — a clean message, not a raw FK error", async () => {
  await seedDatabase(db, { id: "db_1", name: "pg-main", serverId: SERVER });

  await assert.rejects(
    () => asAdmin(() => removeServer(SERVER)),
    (e: Error) => {
      assert.match(e.message, /Move or delete the databases/i);
      assert.match(e.message, /pg-main/);
      // The regression: databases.server_id is RESTRICT, so without the guard the
      // DELETE surfaced Postgres' foreign-key violation to the operator.
      assert.doesNotMatch(e.message, /foreign key|violates/i);
      return true;
    },
  );
});

test("a blocked removal has NO side effects — trust is not revoked on the way out", async () => {
  await seedDatabase(db, { id: "db_1", name: "pg-main", serverId: SERVER });

  await assert.rejects(() => asAdmin(() => removeServer(SERVER)));

  // The old code revoked the pinned cert BEFORE it checked, so a blocked removal
  // permanently de-trusted a server it then refused to remove.
  assert.equal(await pinnedCert(), "sha256:pinned");
  assert.ok(await getServerById(SERVER), "the server row must survive a block");
});

test("a clean removal deletes the row and returns the host-side uninstall command", async () => {
  const result = await asAdmin(() => removeServer(SERVER));

  assert.equal(await getServerById(SERVER), null);
  assert.equal(result.warning, null);
  // Removal never touches the host, so the command is the whole point of it.
  assert.equal(
    result.uninstallCommand,
    "curl -fsSL 'https://deplo.test/uninstall-agent.sh' | sudo bash -s -- --yes",
  );
});

test("warns (but does not block) when an App is mid-move OFF the server", async () => {
  // The App lives on OTHER now, but its volumes are still on SERVER — that is what
  // migrate_from_server_id means, and it is SET NULL when SERVER is deleted.
  const appId = await seedApp(db, { id: "prj_api", slug: "api", serverId: OTHER });
  await db
    .update(appsTable)
    .set({ migrateFromServerId: SERVER })
    .where(eq(appsTable.id, appId));

  const result = await asAdmin(() => removeServer(SERVER));

  assert.equal(await getServerById(SERVER), null, "the removal still goes through");
  assert.ok(result.warning, "a stranded-volume hazard must be surfaced");
  assert.match(result.warning!, /api/);
  assert.match(result.warning!, /mid-move/i);
});

test("refuses to remove the host running Deplo itself", async () => {
  // Registered under the very address this instance answers on — that IS the
  // control-plane box. Removing it revokes the trust Deplo needs to reach its own
  // server and forgets the row, with no in-product way back.
  await seedServerRow(db, { id: "srv_self", name: "this-host", ip: SELF_IP, host: SELF_IP });

  await assert.rejects(
    () => asAdmin(() => removeServer("srv_self")),
    (e: Error) => {
      assert.match(e.message, /host running Deplo itself/i);
      assert.match(e.message, /this-host/);
      return true;
    },
  );
  assert.ok(await getServerById("srv_self"), "the row must survive the refusal");
});

test("the Deplo-host refusal fires BEFORE any side effect", async () => {
  await seedServerRow(db, {
    id: "srv_self",
    name: "this-host",
    ip: SELF_IP,
    host: SELF_IP,
    agent: {
      port: 9443,
      certFingerprint: "sha256:self-pinned",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.0.0",
    },
  });

  await assert.rejects(() => asAdmin(() => removeServer("srv_self")));

  // Same trap the workload guards fell into once: refusing AFTER revoking trust
  // would leave the control plane unable to dial its own host.
  const self = await getServerById("srv_self");
  assert.equal(self?.agent?.certFingerprint, "sha256:self-pinned");
});

test("the guard matches on host as well as ip, and spares unrelated remotes", async () => {
  // Registered by hostname rather than IP: DEPLO_PUBLIC_URL's host is a self-signal too.
  await seedServerRow(db, {
    id: "srv_by_name",
    name: "by-name",
    ip: "192.0.2.99",
    host: "deplo.test",
  });
  await assert.rejects(
    () => asAdmin(() => removeServer("srv_by_name")),
    /host running Deplo itself/i,
  );

  // And the remote at a TEST-NET address is still perfectly removable — the guard
  // must not turn into "no server can ever be deleted".
  await asAdmin(() => removeServer(OTHER));
  assert.equal(await getServerById(OTHER), null);
});

test("only an instance admin can remove a server", async () => {
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_member", teamId: TEAM_A }, () =>
        removeServer(SERVER),
      ),
    /instance admin/i,
  );
  assert.ok(await getServerById(SERVER), "the server row must survive");
});
