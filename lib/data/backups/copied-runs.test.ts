import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { memberships } from "../../db/schema/control-plane/access-control";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { TEAM_A, TEAM_B } from "../identity-test-helpers";
import { SERVER_1 } from "../app-graph-test-helpers";
import { seedDestination, seedRun } from "../backup-test-helpers";
import {
  destinationRemovalImpact,
  deleteDestination,
} from "../destinations/removal";
import { deleteTeam } from "../team-delete";
import { asUser1, seedBase } from "./backups-test-helpers";
import { deleteAllBackupArtifacts, deleteBackupRun } from "./artifact-delete";
import { sweepOrphanedBackupArtifacts } from "./orphan-sweep";
import { pruneRetention } from "./retention";

const OLD = "https://old.deplo.test";
const LONG_AGO = "2020-01-01T00:00:00.000Z";

let db: TestDb;
let pg: PGlite;
let deletes: { key: string; prefix: boolean }[] = [];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setAgentConnectorForTest(
    async () =>
      new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "close") return () => {};
            if (prop === "then") return undefined;
            return async (...args: unknown[]) => {
              if (prop === "s3Delete" || prop === "storeDelete") {
                const t = args[0] as { objectKey?: string; key?: string };
                deletes.push({
                  key: t.objectKey ?? t.key ?? "",
                  prefix: args[1] === true,
                });
                return { ok: true, error: "", deleted: 1 };
              }
              if (prop === "hello")
                return {
                  ok: true,
                  capabilities: [
                    "backup",
                    "backup-store",
                    "backup-encrypt-s3",
                    "backup-s3-args",
                  ],
                };
              return { ok: true };
            };
          },
        },
      ) as unknown as AgentConnection,
  );
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await seedBase(db, pg);
  deletes = [];
});

const key = (id: string) => `deplo/team_a/database/t/${id}.gz`;

async function seed(
  id: string,
  startedAt: string,
  copied: boolean,
  extra: Partial<Parameters<typeof seedRun>[1]> = {},
): Promise<void> {
  await seedRun(db, {
    id,
    destinationId: "s3_1",
    databaseId: "db_1",
    objectKey: key(id),
    startedAt,
    ...extra,
  });
  if (copied)
    await pg.query(`update backup_runs set copied_from = $1 where id = $2`, [
      OLD,
      id,
    ]);
}

const runIds = async () =>
  (
    await pg.query<{ id: string }>(`select id from backup_runs order by id`)
  ).rows.map((r) => r.id);

test("retention never counts nor deletes a copied run", async () => {
  await seed("c_1", "2026-01-01T00:00:00.000Z", true);
  await seed("c_2", "2026-01-02T00:00:00.000Z", true);
  await seed("r_a", "2026-02-01T00:00:00.000Z", false);
  await seed("r_b", "2026-02-02T00:00:00.000Z", false);

  await pruneRetention(
    TEAM_A,
    {
      serverId: SERVER_1,
      kind: "database",
      targetId: "db_1",
      databaseId: "db_1",
      appId: null,
      dbType: "postgres",
      label: "main",
    },
    "s3_1",
    1,
  );

  assert.deepEqual(deletes, [{ key: key("r_a"), prefix: false }]);
  assert.deepEqual(await runIds(), ["c_1", "c_2", "r_b"]);
});

test("deleting a copied run removes its row and leaves its file", async () => {
  await seed("c_1", LONG_AGO, true);
  await asUser1(() => deleteBackupRun("c_1"));
  assert.deepEqual(deletes, []);
  assert.deepEqual(await runIds(), []);
});

test("deleting a target's backups deletes only the files this Deplo wrote", async () => {
  await seed("c_1", LONG_AGO, true);
  await seed("r_a", "2026-02-01T00:00:00.000Z", false);
  await asUser1(() =>
    deleteAllBackupArtifacts({ kind: "database", targetId: "db_1" }),
  );
  assert.deepEqual(deletes, [{ key: key("r_a"), prefix: false }]);
  assert.deepEqual(await runIds(), []);
});

test("the orphan sweep drops a copied run's row and never its file", async () => {
  await seedDestination(db, {
    id: "disk_1",
    kind: "server",
    serverId: SERVER_1,
  });
  const orphan = {
    targetKind: "app" as const,
    appId: null,
    targetId: "prj_gone",
    orphanedAt: LONG_AGO,
    destinationId: "disk_1",
  };
  await seed("c_1", LONG_AGO, true, orphan);
  await seed("r_a", LONG_AGO, false, orphan);
  await sweepOrphanedBackupArtifacts();
  assert.deepEqual(deletes, [{ key: key("r_a"), prefix: false }]);
  assert.deepEqual(await runIds(), []);
});

test("removing a destination with its backups leaves the copied files", async () => {
  await seed("c_1", LONG_AGO, true);
  await seed("r_a", "2026-02-01T00:00:00.000Z", false);
  const impact = await asUser1(() => destinationRemovalImpact("s3_1"));
  assert.equal(impact.artifacts, 1, "only the file that will go is counted");
  await asUser1(() => deleteDestination("s3_1", { deleteArtifacts: true }));
  assert.deepEqual(deletes, [{ key: key("r_a"), prefix: false }]);
  assert.deepEqual(await runIds(), []);
});

const onDisk = {
  databaseId: null,
  targetId: "db_1",
  destinationId: "disk_1",
};

// No app or database left to tear down: the destination's own server is the only one dialled.
async function deleteTeamA(): Promise<void> {
  await pg.exec(`delete from apps; delete from databases;`);
  await db.insert(memberships).values({
    id: "mem_user_1_b",
    userId: "user_1",
    teamId: TEAM_B,
    role: "owner",
    createdAt: LONG_AGO,
  });
  await asUser1(() => deleteTeam(TEAM_A));
  for (let i = 0; i < 100 && deletes.length === 0; i++)
    await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
}

async function seedDisk(): Promise<void> {
  await seedDestination(db, {
    id: "disk_1",
    kind: "server",
    serverId: SERVER_1,
  });
}

test("deleting a team never sweeps a folder that copied runs share", async () => {
  await seedDisk();
  await seed("c_1", LONG_AGO, true, onDisk);
  await seed("r_a", LONG_AGO, false, onDisk);
  await deleteTeamA();
  assert.deepEqual(deletes, [{ key: key("r_a"), prefix: false }]);
});

test("deleting a team on a Deplo never copied sweeps its whole folder", async () => {
  await seedDisk();
  await seed("r_a", LONG_AGO, false, onDisk);
  await deleteTeamA();
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].prefix, true);
});

// The other Deplo keeps this team's id, so the same folder of a shared bucket holds its backups too.
for (const [side, which] of [
  ["source", "the old Deplo (it never holds a copied run)"],
  ["target", "the new Deplo (its copied runs already deleted)"],
] as const)
  test(`a team deleted on ${which} deletes only its own files`, async () => {
    await seedDisk();
    await seed("r_a", LONG_AGO, false, onDisk);
    await db.insert(deploMoves).values({
      id: `dmv_${side}`,
      side,
      state: "done",
      startedBy: "Ada",
      createdAt: LONG_AGO,
      updatedAt: LONG_AGO,
    });
    try {
      await deleteTeamA();
      assert.deepEqual(deletes, [{ key: key("r_a"), prefix: false }]);
    } finally {
      await db.delete(deploMoves);
    }
  });
