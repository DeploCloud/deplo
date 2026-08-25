import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  activities as activitiesTable,
  apps as appsTable,
  appPreviews as appPreviewsTable,
  appVolumes as appVolumesTable,
  pendingTeardowns as pendingTeardownsTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, seedApp, SERVER_1 } from "./app-graph-test-helpers";
import { deleteApp } from "./apps";
import { removeServer } from "./servers";
import {
  MAX_TEARDOWN_ATTEMPTS,
  __setTeardownDialForTest,
  drainTeardowns,
  enqueueTeardowns,
  nextTeardownAttempt,
} from "./teardown-queue";

/**
 * The teardown queue: what happens when the host will not confirm that a stack
 * Deplo was told to destroy is gone.
 */

let db: TestDb;
let pg: PGlite;

const SERVER_2 = "srv_2";
const T0 = new Date("2026-02-01T00:00:00.000Z");

/** Past the grace window a fresh queue row gets, so the drain sees it as due. */
const LATER = () => new Date(Date.now() + 10 * 60_000);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __setTeardownDialForTest(null);
  __resetTestDb();
  await pg.close();
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

beforeEach(async () => {
  __setTeardownDialForTest(null);
  await pg.query(`truncate table
    activities, pending_teardowns, app_previews, app_build_method_settings,
    app_build, apps, servers,
    membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
    ],
  });
  await seedServer(db);
});

/** A fake host: what it still has, and what it was asked to do. */
function fakeAgent(opts: {
  containers?: string[];
  destroyOk?: boolean;
  /** Names left behind AFTER a destroy (defaults to none). */
  after?: string[];
}) {
  const calls = { destroy: 0, stop: 0, list: 0, reclaimed: [] as string[] };
  let names = opts.containers ?? [];
  __setTeardownDialForTest(async () => ({
    destroyStack: async (_slug: string, _rm?: boolean, reclaim?: string[]) => {
      calls.destroy++;
      calls.reclaimed = reclaim ?? [];
      names = opts.after ?? [];
      return { ok: opts.destroyOk ?? true, error: "" };
    },
    listInstances: async () => {
      calls.list++;
      return names.map((name) => ({
        name,
        service: name,
        image: "img",
        running: true,
        exposed: false,
        user: "root",
        workdir: "/",
        openStdin: false,
        tty: false,
        state: "running",
        health: "",
        restartCount: 0,
      }));
    },
    stopStack: async () => {
      calls.stop++;
      return { ok: true, error: "" };
    },
    close: () => {},
  }));
  return calls;
}

const queued = () =>
  db
    .select()
    .from(pendingTeardownsTable)
    .orderBy(pendingTeardownsTable.deployKey);

const messages = async () =>
  (await db.select({ m: activitiesTable.message }).from(activitiesTable)).map(
    (r) => r.m,
  );

test("the backoff ladder is 1m, 5m, 15m, 1h, 6h, 24h, 24h, then it gives up", () => {
  const minutes = (n: number) => {
    const r = nextTeardownAttempt(n, T0);
    assert.equal(r.giveUp, false);
    return (
      (new Date((r as { at: string }).at).getTime() - T0.getTime()) / 60_000
    );
  };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(minutes),
    [1, 5, 15, 60, 360, 1440, 1440],
  );
  assert.deepEqual(nextTeardownAttempt(MAX_TEARDOWN_ATTEMPTS, T0), {
    giveUp: true,
  });
});

test("a delete an unreachable host cannot confirm is queued, not forgotten", async () => {
  await asOwner(async () => {
    await seedApp(db, { id: "prj_1", slug: "blink" });
    await deleteApp("prj_1");
  });
  assert.equal((await db.select().from(appsTable)).length, 0);
  const rows = await queued();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deployKey, "blink");
  assert.equal(rows[0].projectLabel, "prj_1");
  assert.equal(rows[0].serverId, SERVER_1);
  assert.equal(rows[0].teamId, TEAM_A);
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].abandonedAt, null);
  assert.ok(rows[0].lastError.length > 0, "the agent's own error is kept");
  assert.ok(
    (await messages()).some((m) => /will retry the teardown/.test(m)),
    "the trail says the delete is not finished",
  );
});

test("queueing the same stack twice is one row", async () => {
  const entry = {
    serverId: SERVER_1,
    deployKey: "blink",
    projectLabel: "prj_1",
    label: "blink",
    teamId: TEAM_A,
  };
  await enqueueTeardowns([entry]);
  await enqueueTeardowns([{ ...entry, projectLabel: "prj_other" }]);
  const rows = await queued();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectLabel, "prj_1");
});

test("a teardown that is not due yet is left alone", async () => {
  await asOwner(async () => {
    await seedApp(db, { id: "prj_1", slug: "blink" });
    await deleteApp("prj_1");
  });
  const before = (await queued())[0];
  await drainTeardowns(new Date(Date.parse(before.nextAttemptAt) - 1_000));
  const after = (await queued())[0];
  assert.equal(after.attempts, before.attempts);
  assert.equal(after.nextAttemptAt, before.nextAttemptAt);
});

test("a due teardown that fails again backs off further", async () => {
  await asOwner(async () => {
    await seedApp(db, { id: "prj_1", slug: "blink" });
    await deleteApp("prj_1");
  });
  const due = new Date(Date.parse((await queued())[0].nextAttemptAt) + 1_000);
  await drainTeardowns(due);
  const row = (await queued())[0];
  assert.equal(row.attempts, 2);
  assert.equal(
    Math.round((Date.parse(row.nextAttemptAt) - due.getTime()) / 60_000),
    5,
  );
});

test("the last failure gives up out loud and stops retrying", async () => {
  await enqueueTeardowns([
    {
      serverId: SERVER_1,
      deployKey: "blink",
      projectLabel: "prj_1",
      label: "blink",
      teamId: TEAM_A,
    },
  ]);
  await db
    .update(pendingTeardownsTable)
    .set({ attempts: MAX_TEARDOWN_ATTEMPTS - 1 })
    .where(eq(pendingTeardownsTable.deployKey, "blink"));
  await drainTeardowns(LATER());
  const row = (await queued())[0];
  assert.equal(row.attempts, MAX_TEARDOWN_ATTEMPTS);
  assert.ok(row.abandonedAt, "abandoned, so nothing dials it again");
  assert.ok(
    (await messages()).some((m) => /Gave up on the teardown of blink/.test(m)),
    "the trail names what was left behind",
  );
  // Abandoned rows are invisible to the drain.
  await drainTeardowns(new Date(Date.now() + 60 * 60_000));
  assert.equal((await queued())[0].attempts, MAX_TEARDOWN_ATTEMPTS);
});

test("a host with nothing of ours left is never asked to destroy anything", async () => {
  // The reclaimed-slug case: a new app took `blink` on the same server, so its
  // containers carry a DIFFERENT `deplo.project` and the probe answers empty.
  await enqueueTeardowns([
    {
      serverId: SERVER_1,
      deployKey: "blink",
      projectLabel: "prj_1",
      label: "blink",
      teamId: TEAM_A,
    },
  ]);
  const calls = fakeAgent({ containers: [] });
  await drainTeardowns(LATER());
  assert.equal(
    calls.destroy,
    0,
    "no destructive call against somebody else's stack",
  );
  assert.equal((await queued()).length, 0, "and the intent is settled");
  assert.ok(
    (await messages()).some((m) => /Finished the teardown of blink/.test(m)),
  );
});

test("a container that survives the teardown keeps the row and is stopped", async () => {
  await enqueueTeardowns([
    {
      serverId: SERVER_1,
      deployKey: "blink",
      projectLabel: "prj_1",
      label: "blink",
      teamId: TEAM_A,
    },
  ]);
  const calls = fakeAgent({
    containers: ["deplo-blink-web-1"],
    // The agent claims success while the container is still there - the exact
    // lie the verify exists for.
    destroyOk: true,
    after: ["deplo-blink-web-1"],
  });
  await drainTeardowns(LATER());
  assert.equal(calls.stop, 1, "whatever is left must at least stop serving");
  const row = (await queued())[0];
  assert.equal(row.attempts, 1);
  assert.match(row.lastError, /survived the teardown/);
});

test("a preview keyed off the same slug is not swept up by the app's row", async () => {
  await enqueueTeardowns([
    {
      serverId: SERVER_1,
      deployKey: "blink",
      projectLabel: "prj_1",
      label: "blink",
      teamId: TEAM_A,
    },
  ]);
  // `deplo-blink__pr-3-web-1` belongs to the preview, not to `blink`.
  const calls = fakeAgent({ containers: ["deplo-blink__pr-3-web-1"] });
  await drainTeardowns(LATER());
  assert.equal(calls.destroy, 0);
  assert.equal((await queued()).length, 0);
});

test("a database container, which carries no deplo- prefix, still counts", async () => {
  // The agent names a database container after its bare host. A survivor check
  // that only looked for `deplo-<key>` would call a live database gone.
  await enqueueTeardowns([
    {
      serverId: SERVER_1,
      deployKey: "db-shop",
      projectLabel: "db_1",
      label: "shop",
      teamId: TEAM_A,
    },
  ]);
  const calls = fakeAgent({
    containers: ["db-shop"],
    destroyOk: true,
    after: ["db-shop"],
  });
  await drainTeardowns(LATER());
  assert.equal(calls.stop, 1);
  assert.match((await queued())[0].lastError, /survived the teardown/);
});

test("a teardown with no team left speaks in the log, never in a stranger's trail", async () => {
  await enqueueTeardowns([
    {
      serverId: SERVER_1,
      deployKey: "gone",
      projectLabel: "prj_gone",
      label: "gone",
      teamId: null,
    },
  ]);
  await db
    .update(pendingTeardownsTable)
    .set({ attempts: MAX_TEARDOWN_ATTEMPTS - 1 })
    .where(eq(pendingTeardownsTable.deployKey, "gone"));
  await drainTeardowns(LATER());
  assert.ok((await queued())[0].abandonedAt);
  assert.deepEqual(await messages(), []);
});

test("a host that comes back earns an abandoned teardown a new ladder", async () => {
  await enqueueTeardowns([
    {
      serverId: SERVER_1,
      deployKey: "blink",
      projectLabel: "prj_1",
      label: "blink",
      teamId: TEAM_A,
    },
  ]);
  const now = new Date();
  await db
    .update(pendingTeardownsTable)
    .set({
      attempts: MAX_TEARDOWN_ATTEMPTS,
      abandonedAt: new Date(now.getTime() - 2 * 60 * 60_000).toISOString(),
    })
    .where(eq(pendingTeardownsTable.deployKey, "blink"));
  await db
    .update(serversTable)
    .set({ status: "online", lastSeenAt: now.toISOString() })
    .where(eq(serversTable.id, SERVER_1));
  const calls = fakeAgent({ containers: ["deplo-blink"], after: [] });
  await drainTeardowns(now);
  assert.equal(calls.destroy, 1, "the retry actually ran");
  assert.equal((await queued()).length, 0);
});

test("removing a server drops its queued teardowns and says how many", async () => {
  await seedServer(db, SERVER_2);
  await enqueueTeardowns([
    {
      serverId: SERVER_1,
      deployKey: "blink",
      projectLabel: "prj_1",
      label: "blink",
      teamId: TEAM_A,
    },
    {
      serverId: SERVER_2,
      deployKey: "other",
      projectLabel: "prj_2",
      label: "other",
      teamId: TEAM_A,
    },
  ]);
  await asOwner(() => removeServer(SERVER_1));
  const rows = await queued();
  assert.deepEqual(
    rows.map((r) => r.deployKey),
    ["other"],
  );
  assert.ok(
    (await messages()).some((m) =>
      /1 pending teardown on srv_1 was dropped/.test(m),
    ),
  );
});

test("a preview pinned to its own server is queued on THAT host", async () => {
  await seedServer(db, SERVER_2);
  await asOwner(async () => {
    await seedApp(db, { id: "prj_1", slug: "blink" });
    await db
      .update(appsTable)
      .set({ previewServerId: SERVER_2 })
      .where(eq(appsTable.id, "prj_1"));
    await db.insert(appPreviewsTable).values({
      id: "pvw_1",
      appId: "prj_1",
      prNumber: 3,
      headBranch: "feature",
      deployKey: "blink__pr-3",
      host: "blink-pr-3.example.com",
      lastActivityAt: T0.toISOString(),
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    });
    await deleteApp("prj_1");
  });
  const rows = await queued();
  assert.deepEqual(
    rows.map((r) => [r.deployKey, r.serverId, r.projectLabel]),
    [
      ["blink", SERVER_1, "prj_1"],
      ["blink__pr-3", SERVER_2, "pvw_1"],
    ],
  );
});

test("a delete names the app's own volumes, so a never-deployed stack loses them too", async () => {
  const calls = fakeAgent({ containers: [] });
  await asOwner(async () => {
    await seedApp(db, { id: "prj_1", slug: "blink" });
    // A Storage-settings volume (rendered with its own `name:`) and a host bind,
    // which is NOT Deplo's to remove.
    await db.insert(appVolumesTable).values([
      {
        appId: "prj_1",
        position: 0,
        volumeId: "vol_1",
        type: "named",
        name: "data",
        mountPath: "/data",
        readOnly: false,
      },
      {
        appId: "prj_1",
        position: 1,
        volumeId: "vol_2",
        type: "host",
        name: "etc",
        hostPath: "/etc/blink",
        mountPath: "/etc/blink",
        readOnly: false,
      },
    ]);
    // Plus what the user's own compose declares: `cache` is Deplo's to create,
    // `shared` points at a volume that already exists elsewhere.
    await db
      .update(appsTable)
      .set({
        compose:
          "services:\n  web:\n    image: nginx\nvolumes:\n  cache: {}\n  shared:\n    external: true\n",
      })
      .where(eq(appsTable.id, "prj_1"));
    await deleteApp("prj_1");
  });
  assert.equal(calls.destroy, 1);
  assert.deepEqual(
    calls.reclaimed.sort(),
    ["deplo-blink-data", "deplo-blink_cache"],
    "its own two volumes by name; never the host path, never the foreign volume",
  );
});
