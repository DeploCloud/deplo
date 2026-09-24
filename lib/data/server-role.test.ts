import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { addServer } from "./servers/enrollment";
import {
  serverRole,
  getServerById,
  listServerChoices,
  listBuildServerChoices,
  canHostWorkloads,
} from "./servers/roster";
import {
  setServerAgentCanary,
  setServerRole,
  setServerBuildFallback,
} from "./servers/settings";

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
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("an empty server can take any role, and come back", async () => {
  await asOwner(async () => {
    for (const role of ["build", "storage", "everything"] as const) {
      const s = await setServerRole(SERVER_1, role);
      assert.equal(serverRole(s), role, `could not become ${role}`);
    }
  });
});

test('an unknown role is refused, not read as "everything"', async () => {
  await asOwner(async () => {
    await setServerRole(SERVER_1, "build");
    await assert.rejects(
      () => setServerRole(SERVER_1, "backups" as never),
      /Unknown server role/,
    );
    assert.equal(serverRole((await getServerById(SERVER_1))!), "build");
  });
});

test("the two specialised roles are exclusive in the row, not just in the UI", async () => {
  await asOwner(async () => {
    await setServerRole(SERVER_1, "build");
    let s = (await getServerById(SERVER_1))!;
    assert.equal(s.buildOnly, true);
    assert.equal(s.storageOnly, false, "picking one must clear the other");

    await setServerRole(SERVER_1, "storage");
    s = (await getServerById(SERVER_1))!;
    assert.equal(s.storageOnly, true);
    assert.equal(s.buildOnly, false);
  });
});

test("a host that still runs something cannot be retired into either role", async () => {
  await seedApp(db, { id: "prj_live", serverId: SERVER_1 });
  await asOwner(async () => {
    for (const role of ["build", "storage"] as const) {
      await assert.rejects(
        () => setServerRole(SERVER_1, role),
        /Move or delete the apps/,
        `${role} was accepted while an app still lived there`,
      );
    }
    assert.equal(serverRole((await getServerById(SERVER_1))!), "everything");
  });
});

test("going BACK to everything is always allowed - nothing is stranded by it", async () => {
  await asOwner(async () => {
    await setServerRole(SERVER_1, "build");
    const s = await setServerRole(SERVER_1, "everything");
    assert.equal(serverRole(s), "everything");
  });
});

test("a backups-only server with no Docker is pinned to that role", async () => {
  await db
    .update((await import("../db/schema/control-plane/servers")).servers)
    .set({ storageOnly: true, buildOnly: false, dockerVersion: "" })
    .where(
      (await import("drizzle-orm")).eq(
        (await import("../db/schema/control-plane/servers")).servers.id,
        SERVER_1,
      ),
    );
  await asOwner(async () => {
    for (const role of ["everything", "build"] as const) {
      await assert.rejects(
        () => setServerRole(SERVER_1, role),
        /no Docker on it/,
        `${role} was accepted on a host with no Docker`,
      );
    }
  });
});

test("a Docker-having server retired into storage can still come back", async () => {
  await asOwner(async () => {
    await setServerRole(SERVER_1, "storage");
    const s = await setServerRole(SERVER_1, "everything");
    assert.equal(serverRole(s), "everything");
  });
});

test("either specialised role drops the host out of the deploy-target picker", async () => {
  await asOwner(async () => {
    assert.ok(
      (await listServerChoices()).some((c) => c.id === SERVER_1),
      "an ordinary server is offered",
    );
    for (const role of ["build", "storage"] as const) {
      await setServerRole(SERVER_1, role);
      assert.equal(
        (await listServerChoices()).some((c) => c.id === SERVER_1),
        false,
        `a ${role} server was still offered as a deploy target`,
      );
    }
  });
});

async function addMigrationSource(name = "dokploy-host", host = "10.9.9.9") {
  const { server } = await addServer({ name, host, importOnly: true });
  return server;
}

test("a migration source is not a role anyone can pick, and not one it can leave", async () => {
  await asOwner(async () => {
    await assert.rejects(
      () => setServerRole(SERVER_1, "import" as never),
      /created by the import wizard/,
      "an ordinary server was demoted into a migration source",
    );
    assert.equal(serverRole((await getServerById(SERVER_1))!), "everything");

    const src = await addMigrationSource();
    for (const role of ["everything", "build", "storage"] as const) {
      await assert.rejects(
        () => setServerRole(src.id, role),
        /Re-run the install command/,
        `a migration source was promoted to ${role}`,
      );
    }
    assert.equal(serverRole((await getServerById(src.id))!), "import");
  });
});

test("a migration source is out of the deploy picker AND the build picker", async () => {
  await asOwner(async () => {
    const src = await addMigrationSource();
    assert.equal(canHostWorkloads(src), false);
    assert.equal(
      (await listServerChoices()).some((c) => c.id === src.id),
      false,
      "a migration source was offered as a deploy target",
    );
    const builders = await listBuildServerChoices();
    assert.ok(
      builders.some((c) => c.id === SERVER_1),
      "an ordinary server is still a legal builder",
    );
    assert.equal(
      builders.some((c) => c.id === src.id),
      false,
      "a migration source was offered as a build server",
    );
  });
});

test("a build-only server is still a legal builder, unlike a migration source", async () => {
  await asOwner(async () => {
    await setServerRole(SERVER_1, "build");
    assert.ok(
      (await listBuildServerChoices()).some((c) => c.id === SERVER_1),
      "a build-only server must stay in the build picker - that is what it is for",
    );
  });
});

test("the Deplo host is a build fallback with nobody configuring anything", async () => {
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  try {
    await asOwner(async () => {
      const panel = (await listBuildServerChoices()).find(
        (c) => c.id === SERVER_1,
      );
      assert.equal(panel?.isDeploHost, true);
      assert.equal(panel?.buildFallback, true);

      await setServerBuildFallback(SERVER_1, false);
      assert.equal(
        (await listBuildServerChoices()).find((c) => c.id === SERVER_1)
          ?.buildFallback,
        false,
      );
      await setServerBuildFallback(SERVER_1, null);
      assert.equal((await getServerById(SERVER_1))!.buildFallback, null);
    });
  } finally {
    delete process.env.DEPLO_SERVER_IP;
  }
});

test("an ordinary server joins the pool only when it is marked", async () => {
  process.env.DEPLO_SERVER_IP = "203.0.113.1";
  try {
    await asOwner(async () => {
      assert.equal(
        (await listBuildServerChoices()).find((c) => c.id === SERVER_1)
          ?.buildFallback,
        false,
        "a remote must not build for other servers until someone says so",
      );
      await setServerBuildFallback(SERVER_1, true);
      assert.equal(
        (await listBuildServerChoices()).find((c) => c.id === SERVER_1)
          ?.buildFallback,
        true,
      );
    });
  } finally {
    delete process.env.DEPLO_SERVER_IP;
  }
});

test("a backups-only host cannot be marked as a build fallback", async () => {
  await asOwner(async () => {
    await setServerRole(SERVER_1, "storage");
    await assert.rejects(
      () => setServerBuildFallback(SERVER_1, true),
      /backups only/,
      "a host with no Docker was accepted as a builder",
    );
    await setServerBuildFallback(SERVER_1, false);
    assert.equal((await getServerById(SERVER_1))!.buildFallback, false);
  });
});

test("canary agent releases are a per-server switch, off by default", async () => {
  await asOwner(async () => {
    const before = (await getServerById(SERVER_1))!;
    assert.equal(before.agentCanary, false);
    const on = await setServerAgentCanary(SERVER_1, true);
    assert.equal(on.agentCanary, true);
    assert.equal(on.agent?.version, before.agent?.version, "nothing installs");
    const off = await setServerAgentCanary(SERVER_1, false);
    assert.equal(off.agentCanary, false);
  });
});
