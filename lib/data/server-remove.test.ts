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
import { seedDatabase, seedDestination } from "./backup-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import {
  getServerById,
  removeServer,
  addServer,
  uninstallServerAgent,
} from "./servers";
import { __setAgentConnectorForTest } from "../infra/agent-client";

/**
 * Removal is TRUST REVOCATION + FORGETTING, not a host uninstall - these tests pin
 * that contract, which previously had zero coverage while the UI claimed the
 * opposite ("tells it to tear down its containers").
 */

let db: TestDb;
let pg: PGlite;

const SERVER = "srv_target";
const OTHER = "srv_other";
/**
 * RFC 5737 TEST-NET-1, not the helper's default 10.0.0.1. A TEST-NET address is
 * guaranteed never to be assigned to an interface.
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
    truncate table backup_destination, databases, activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "user_member",
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
      },
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

test("blocks removal while a backup destination keeps its artifacts here", async () => {
  await seedDestination(db, {
    id: "dst_here",
    name: "Nightly backups",
    kind: "server",
    serverId: SERVER,
  });

  await assert.rejects(
    () => asAdmin(() => removeServer(SERVER)),
    (e: Error) => {
      assert.match(e.message, /backup destinations/i);
      assert.match(e.message, /Nightly backups/);
      // The whole point: backup_destination.server_id is RESTRICT, so without
      // this guard the preflight passes, trust is revoked, and only THEN does
      // the DELETE blow up, leaving the operator a Postgres constraint string
      // and a server that can never be removed.
      assert.doesNotMatch(e.message, /foreign key|violates/i);
      return true;
    },
  );
  // Nothing was touched on the way to the refusal.
  assert.notEqual(await pinnedCert(), "");
});

test("blocks removal while a database is hosted - a clean message, not a raw FK error", async () => {
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

test("a blocked removal has NO side effects - trust is not revoked on the way out", async () => {
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
    "curl -fsSL 'https://deplo.test/uninstall.sh' --output /tmp/deplo-uninstall.sh && sudo bash /tmp/deplo-uninstall.sh --yes --agent-only",
  );
});

test("warns (but does not block) when an App is mid-move OFF the server", async () => {
  // The App lives on OTHER now, but its volumes are still on SERVER - that is what
  // migrate_from_server_id means, and it is SET NULL when SERVER is deleted.
  const appId = await seedApp(db, {
    id: "prj_api",
    slug: "api",
    serverId: OTHER,
  });
  await db
    .update(appsTable)
    .set({ migrateFromServerId: SERVER })
    .where(eq(appsTable.id, appId));

  const result = await asAdmin(() => removeServer(SERVER));

  assert.equal(
    await getServerById(SERVER),
    null,
    "the removal still goes through",
  );
  assert.ok(result.warning, "a stranded-volume hazard must be surfaced");
  assert.match(result.warning!, /api/);
  assert.match(result.warning!, /mid-move/i);
});

test("refuses to remove the host running Deplo itself", async () => {
  // Registered under the very address this instance answers on - that IS the
  // control-plane box. Removing it revokes the trust Deplo needs to reach its own
  // server and forgets the row, with no in-product way back.
  await seedServerRow(db, {
    id: "srv_self",
    name: "this-host",
    ip: SELF_IP,
    host: SELF_IP,
  });

  await assert.rejects(
    () => asAdmin(() => removeServer("srv_self")),
    (e: Error) => {
      assert.match(e.message, /host running Deplo itself/i);
      assert.match(e.message, /this-host/);
      return true;
    },
  );
  assert.ok(
    await getServerById("srv_self"),
    "the row must survive the refusal",
  );
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

  // And the remote at a TEST-NET address is still perfectly removable - the guard
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

/* ------------------------------------------------------------------ */
/* Uninstalling a MIGRATION SOURCE                                      */
/* ------------------------------------------------------------------ */

/**
 * The one case where Deplo DOES touch the host, and the reason it is not a
 * contradiction of the above: the agent on a migration source was installed by
 * Deplo, on a machine that is not part of the fleet, for one import. Ending that
 * by handing someone a shell command would be the failure the product exists to
 * remove.
 *
 * What these lock is the ORDER, because getting it wrong is silent: the guards run
 * before the RPC (a destination on the host is ON DELETE RESTRICT, so discovering
 * it afterwards would leave a de-agented server nobody can remove), and the row
 * survives every failure - a deleted row plus a live agent is a machine nobody can
 * see and nobody can clean.
 */

/** A stand-in agent. `capabilities` and `fail` decide which branch is exercised. */
function fakeAgent(opts: { capabilities?: string[]; fail?: Error } = {}) {
  const calls = { hello: 0, uninstall: 0 };
  const conn = {
    hello: async () => {
      calls.hello++;
      return { capabilities: opts.capabilities ?? ["self-uninstall"] };
    },
    selfUninstall: async () => {
      calls.uninstall++;
      if (opts.fail) throw opts.fail;
      return [
        "/etc/systemd/system/deplo-agent.service",
        "/var/lib/deplo-agent",
      ];
    },
    close: () => {},
  };
  __setAgentConnectorForTest(
    async () =>
      conn as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );
  return calls;
}

/** Register a migration source the only way there is, then give it an agent. */
async function seedMigrationSource(host = "192.0.2.50") {
  const { server } = await asAdmin(() =>
    addServer({ name: "dokploy-host", host, importOnly: true }),
  );
  const { servers } = await import("../db/schema/control-plane");
  await db
    .update(servers)
    // Fingerprints are unique across the fleet (a partial unique index), so this
    // has to differ from the target server's.
    .set({ agentCertFingerprint: `sha256:${server.id}`, agentPort: 9443 })
    .where(eq(servers.id, server.id));
  return server.id;
}

test("uninstalling a migration source removes the agent, then the row", async () => {
  const id = await seedMigrationSource();
  const calls = fakeAgent();
  try {
    const res = await asAdmin(() => uninstallServerAgent(id));
    assert.equal(res.removed, true);
    assert.equal(res.error, null);
    assert.match(res.uninstallCommand, /uninstall\.sh'.*--yes --agent-only$/);
    assert.equal(
      calls.uninstall,
      1,
      "the agent was never asked to uninstall itself",
    );
    assert.equal(
      await getServerById(id),
      null,
      "the row outlived the uninstall",
    );
  } finally {
    __setAgentConnectorForTest();
  }
});

test("an agent that cannot uninstall itself KEEPS the row, and hands over the command", async () => {
  const id = await seedMigrationSource();
  // Too old to know the RPC: it does not advertise the capability.
  const calls = fakeAgent({ capabilities: ["self-update"] });
  try {
    const res = await asAdmin(() => uninstallServerAgent(id));
    assert.equal(res.removed, false);
    assert.match(res.error ?? "", /too old/i);
    assert.match(res.uninstallCommand, /uninstall\.sh'.*--yes --agent-only$/);
    assert.equal(calls.uninstall, 0, "an unsupported agent must not be called");
    assert.ok(
      await getServerById(id),
      "the row must survive a failed uninstall",
    );
  } finally {
    __setAgentConnectorForTest();
  }
});

test("a migration source Deplo cannot reach can still be forgotten", async () => {
  // The dead end this closes: uninstalling needs the agent to ANSWER, and this row
  // exists because it does not.
  const id = await seedMigrationSource();
  const calls = fakeAgent({ capabilities: ["self-update"] });
  try {
    const stuck = await asAdmin(() => uninstallServerAgent(id));
    assert.equal(
      stuck.removed,
      false,
      "the precondition: it will not uninstall",
    );
    assert.ok(await getServerById(id));

    const gone = await asAdmin(() => removeServer(id));
    assert.match(gone.uninstallCommand, /uninstall\.sh'.*--yes --agent-only$/);
    assert.equal(await getServerById(id), null, "the row is gone");
    assert.equal(calls.uninstall, 0, "and nothing was dialed to get there");
  } finally {
    __setAgentConnectorForTest();
  }
});

test("a blocked removal fails BEFORE the host is touched", async () => {
  const id = await seedMigrationSource();
  // A destination pointing at the host: server_id is ON DELETE RESTRICT, so
  // uninstalling first would strip the agent off a server that then cannot be
  // deleted - and cannot be reached to try again.
  await seedDestination(db, {
    id: "dst_on_source",
    name: "Nightly backups",
    kind: "server",
    serverId: id,
  });
  const calls = fakeAgent();
  try {
    await assert.rejects(
      () => asAdmin(() => uninstallServerAgent(id)),
      /backup destinations/i,
    );
    assert.equal(
      calls.hello,
      0,
      "the agent was dialed despite a blocking guard",
    );
    assert.ok(await getServerById(id), "the row must survive");
  } finally {
    __setAgentConnectorForTest();
  }
});

test("a registration whose install command was never run is simply forgotten", async () => {
  // No agent ever called home, so there is nothing on the host to remove - and
  // this is the ONLY way that row can leave, now that a migration source has no
  // management page.
  const { server } = await asAdmin(() =>
    addServer({
      name: "never-installed",
      host: "192.0.2.60",
      importOnly: true,
    }),
  );
  const calls = fakeAgent();
  try {
    const res = await asAdmin(() => uninstallServerAgent(server.id));
    assert.equal(res.removed, true);
    assert.equal(calls.hello, 0, "nothing should have been dialed");
    assert.equal(await getServerById(server.id), null);
  } finally {
    __setAgentConnectorForTest();
  }
});

test("an ordinary server is not uninstalled this way", async () => {
  await assert.rejects(
    () => asAdmin(() => uninstallServerAgent(SERVER)),
    /not a migration source/i,
  );
  assert.ok(await getServerById(SERVER), "the row must survive");
});

test("only an instance admin can uninstall an agent", async () => {
  const id = await seedMigrationSource();
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_member", teamId: TEAM_A }, () =>
        uninstallServerAgent(id),
      ),
    /instance admin/i,
  );
  assert.ok(await getServerById(id), "the row must survive");
});

test("a migration source cannot be registered on a machine Deplo already stands on", async () => {
  await assert.rejects(
    () =>
      asAdmin(() =>
        addServer({ name: "same-box", host: SELF_IP, importOnly: true }),
      ),
    /machine Deplo itself runs on/i,
    "the Deplo host was accepted as a migration source",
  );
  // Nor a second row for a host that is already registered: the installer would
  // clear that agent's materials and re-bootstrap it as a migration source, and
  // the uninstall would then take a real server off the fleet.
  await assert.rejects(
    () =>
      asAdmin(() =>
        addServer({ name: "again", host: REMOTE_IP, importOnly: true }),
      ),
    /already registered at that address/i,
  );
});
