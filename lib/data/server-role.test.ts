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
import { setServerRole, serverRole, getServerById, listServerChoices } from "./servers";

/**
 * What a server is FOR, and the one direction that is genuinely one-way.
 *
 * A role is a CONTROL-PLANE decision - which pickers offer the host, which
 * readiness rows apply - so a host that has Docker can take any of the three and
 * go back. The exception is physical, not policy: a server installed as
 * backups-only never had Docker put on it, and no write here can change that.
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
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
  await seedServer(db); // SERVER_1, "everything", dockerVersion set by the seeder
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
    // ...and the row is untouched, so a refused change leaves nothing half-applied.
    assert.equal(serverRole((await getServerById(SERVER_1))!), "everything");
  });
});

test("going BACK to everything is always allowed - nothing is stranded by it", async () => {
  await asOwner(async () => {
    await setServerRole(SERVER_1, "build");
    // No workload check on the way back: a build server hosts nothing by
    // definition, so there is never anything to move off it first.
    const s = await setServerRole(SERVER_1, "everything");
    assert.equal(serverRole(s), "everything");
  });
});

test("a backups-only server with no Docker is pinned to that role", async () => {
  // The installer's storage-only branch never puts Docker on the box, and an
  // agent that has none reports no version. That is the signal, and it is the
  // only thing here that a database write genuinely cannot undo.
  await db
    .update((await import("../db/schema/control-plane")).servers)
    .set({ storageOnly: true, buildOnly: false, dockerVersion: "" })
    .where((await import("drizzle-orm")).eq(
      (await import("../db/schema/control-plane")).servers.id,
      SERVER_1,
    ));
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
  // The case the pin above must NOT catch: somebody merely repurposed a normal
  // host. Docker is still on it, so nothing physical stops the return trip.
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
