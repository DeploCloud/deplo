import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { eq } from "drizzle-orm";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_PROJECT_GRAPH, seedApp } from "./app-graph-test-helpers";
import { seedDatabase, seedDestination } from "./backup-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { addServer } from "./servers/enrollment";
import { removeServer, uninstallServerAgent } from "./servers/removal";
import { getServerById, listAllServers } from "./servers/roster";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";

let db: TestDb;
let pg: PGlite;

const SERVER = "srv_target";
const OTHER = "srv_other";
const REMOTE_IP = "192.0.2.10";
const SELF_IP = "192.0.2.200";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_PUBLIC_URL = "https://deplo.test";
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
      assert.doesNotMatch(e.message, /foreign key|violates/i);
      return true;
    },
  );
  assert.notEqual(await pinnedCert(), "");
});

test("blocks removal while a database is hosted - a clean message, not a raw FK error", async () => {
  await seedDatabase(db, { id: "db_1", name: "pg-main", serverId: SERVER });

  await assert.rejects(
    () => asAdmin(() => removeServer(SERVER)),
    (e: Error) => {
      assert.match(e.message, /Move or delete the databases/i);
      assert.match(e.message, /pg-main/);
      assert.doesNotMatch(e.message, /foreign key|violates/i);
      return true;
    },
  );
});

test("a blocked removal has NO side effects - trust is not revoked on the way out", async () => {
  await seedDatabase(db, { id: "db_1", name: "pg-main", serverId: SERVER });

  await assert.rejects(() => asAdmin(() => removeServer(SERVER)));

  assert.equal(await pinnedCert(), "sha256:pinned");
  assert.ok(await getServerById(SERVER), "the server row must survive a block");
});

test("a clean removal deletes the row and returns the host-side uninstall command", async () => {
  const result = await asAdmin(() => removeServer(SERVER));

  assert.equal(await getServerById(SERVER), null);
  assert.equal(result.warning, null);
  assert.equal(
    result.uninstallCommand,
    "curl -fsSL 'https://deplo.test/uninstall.sh' --output /tmp/deplo-uninstall.sh && sudo bash /tmp/deplo-uninstall.sh --yes --agent-only",
  );
});

test("warns (but does not block) when an App is mid-move OFF the server", async () => {
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

  const self = await getServerById("srv_self");
  assert.equal(self?.agent?.certFingerprint, "sha256:self-pinned");
});

test("the guard matches on host as well as ip, and spares unrelated remotes", async () => {
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
        ReturnType<typeof import("../infra/agent-client/connect").connectAgent>
      >,
  );
  return calls;
}

async function seedMigrationSource(host = "192.0.2.50") {
  const { server } = await asAdmin(() =>
    addServer({ name: "dokploy-host", host, importOnly: true }),
  );
  const { servers } = await import("../db/schema/control-plane/servers");
  await db
    .update(servers)
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
});

test("a server Deplo already reaches is offered, never registered twice", async () => {
  const before = (await listAllServers()).length;
  const res = await asAdmin(() =>
    addServer({ name: "again", host: REMOTE_IP, importOnly: true }),
  );
  assert.equal(
    res.server.id,
    SERVER,
    "a second row was created for one machine",
  );
  assert.equal(res.installCommand, "", "a real server was told to reinstall");
  assert.equal((await listAllServers()).length, before);
  const server = await getServerById(SERVER);
  assert.equal(
    server?.importOnly,
    false,
    "a real server was demoted to a source",
  );
  assert.equal(
    await pinnedCert(),
    "sha256:pinned",
    "its pinned trust was reissued",
  );
});

test("a source whose agent never answered gets its command back, not a refusal", async () => {
  const first = await asAdmin(() =>
    addServer({ name: "coolify-host", host: "192.0.2.60", importOnly: true }),
  );
  const before = (await listAllServers()).length;

  const again = await asAdmin(() =>
    addServer({ name: "coolify-host", host: "192.0.2.60", importOnly: true }),
  );
  assert.equal(
    again.server.id,
    first.server.id,
    "the leftover row was not reused",
  );
  assert.ok(again.installCommand.length > 0, "no way to install the agent");
  assert.notEqual(
    again.installCommand,
    first.installCommand,
    "the same single-use token was handed out twice",
  );
  assert.equal((await listAllServers()).length, before);
});

test("a source that already answered is offered, not re-bootstrapped", async () => {
  const id = await seedMigrationSource("192.0.2.70");
  fakeAgent();
  const res = await asAdmin(() =>
    addServer({ name: "coolify-host", host: "192.0.2.70", importOnly: true }),
  );
  assert.equal(res.server.id, id);
  assert.equal(res.installCommand, "");
});

test("a source whose agent is GONE is told to install again", async () => {
  const id = await seedMigrationSource("192.0.2.71");
  __setAgentConnectorForTest(async () => {
    throw new Error("connect ECONNREFUSED 192.0.2.71:9443");
  });

  const res = await asAdmin(() =>
    addServer({ name: "coolify-host", host: "192.0.2.71", importOnly: true }),
  );

  assert.equal(res.server.id, id, "a second row for one machine");
  assert.ok(res.installCommand.length > 0, "no way to put the agent back");
});

test("a source another team left behind follows the team reading it now", async () => {
  const id = await seedMigrationSource("192.0.2.72");
  const { serverTeams } = await import("../db/schema/control-plane/servers");
  await db
    .update(serverTeams)
    .set({ teamId: TEAM_B })
    .where(eq(serverTeams.serverId, id));
  const { servers } = await import("../db/schema/control-plane/servers");
  await db
    .update(servers)
    .set({ uninstallAttempts: 3, uninstallError: "no answer" })
    .where(eq(servers.id, id));
  __setAgentConnectorForTest(async () => {
    throw new Error("connect ECONNREFUSED 192.0.2.72:9443");
  });

  await asAdmin(() =>
    addServer({ name: "coolify-host", host: "192.0.2.72", importOnly: true }),
  );

  const [grant] = await db
    .select()
    .from(serverTeams)
    .where(eq(serverTeams.serverId, id));
  assert.equal(
    grant?.teamId,
    TEAM_A,
    "the new walk cannot see its own machine",
  );
  const back = await getServerById(id);
  assert.equal(back?.uninstallError, "", "the old walk's verdict still stands");
});
