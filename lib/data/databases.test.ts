// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  activities as activitiesTable,
  backups as backupsTable,
  backupRuns as backupRunsTable,
  databases as databasesTable,
  pendingTeardowns as pendingTeardownsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer } from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client";
import {
  seedBackup,
  seedDatabase,
  seedRun,
  seedS3,
  settleProvisioning,
  TRUNCATE_BACKUPS,
} from "./backup-test-helpers";
import {
  createDatabase,
  hostPortsInUse,
  getConnectionString,
  getDatabase,
  listDatabases,
  deleteDatabase,
  dbVolumeHostName,
  updateDatabase,
  updateDatabaseResources,
  updateDatabaseImage,
  restartDatabase,
  redeployDatabase,
  rebuildDatabase,
  rotateDatabasePassword,
  rotationExecCommand,
  reorderDatabases,
  renameDatabase,
  updateDatabaseLogo,
  setDatabaseMounts,
  validateDatabaseMounts,
} from "./databases";
import { generateDatabaseCompose } from "../deploy/database-compose";
import { composeStackVolumeHostNames } from "./project-backup-descriptor";

/**
 * Data-layer tests for `databases` against pglite (PLAN Step 5, cut-set (d)).
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  await settleProvisioning(db);
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  // Drain the previous test's floated provisioning before its rows disappear.
  await settleProvisioning(db);
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
      // Holds the Capability but not the instance grant - an owner holds
      // canExposePorts implicitly, so only a member can prove that gate.
      {
        id: USER_MEMBER,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "configure_databases"],
      },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** A member who may configure databases but may not publish a host port. */
const USER_MEMBER = "user_member";

test("listDatabases is team-scoped, newest-first, and masks the connection string", async () => {
  await seedDatabase(db, { id: "db_old", name: "old" });
  // A newer row (later createdAt) must sort first.
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_old"));
  await seedDatabase(db, { id: "db_new", name: "new" });
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_new"));
  // A foreign-team database is invisible.
  await seedDatabase(db, { id: "db_other", teamId: TEAM_B, name: "other" });

  await asUser1(async () => {
    const list = await listDatabases();
    assert.deepEqual(
      list.map((d) => d.id),
      ["db_new", "db_old"],
    );
    assert.equal(
      "connectionStringEnc" in list[0]!,
      false,
      "no secret in the DTO",
    );
    assert.ok(
      list[0]!.connectionStringMasked.includes("••••"),
      "password masked",
    );
  });
});

test("getConnectionString decrypts; getDatabase is team-scoped", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  await asUser1(async () => {
    const conn = await getConnectionString("db_1");
    assert.ok(conn.startsWith("postgres://"), "decrypted plaintext");
    assert.ok((await getDatabase("db_1")) !== null);
  });
  // user_2 (team B) cannot see team A's database.
  await runWithIdentity({ userId: "user_2", teamId: TEAM_B }, async () => {
    assert.equal(await getDatabase("db_1"), null);
    await assert.rejects(() => getConnectionString("db_1"), /Not found/);
  });
});

/**
 * The seeded server has no agent record, so `connectAgent` throws before a socket
 * is opened - the "host we cannot clean" case, without any gRPC in the test.
 * A delete that cannot prove the container and volume are gone must delete
 * NOTHING: the database stays Deplo's to retry, stop or move, instead of becoming
 * a live container the control plane has forgotten about.
 */
test("deleteDatabase refuses (deleting nothing) when the server can't be torn down", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  const s3 = await seedS3(db, { id: "s3_1" });
  await seedBackup(db, { id: "bkp_1", destinationId: s3, databaseId: "db_1" });

  await asUser1(() =>
    assert.rejects(
      () => deleteDatabase("db_1"),
      // Names the database, says nothing was deleted, and points at the escape hatch.
      /main was NOT deleted[\s\S]*delete it\s+anyway/i,
    ),
  );

  assert.equal(
    (
      await db
        .select()
        .from(databasesTable)
        .where(eq(databasesTable.id, "db_1"))
    ).length,
    1,
    "the database row survives a refused delete",
  );
  assert.equal(
    (await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1")))
      .length,
    1,
    "its backup schedule survives too (nothing cascaded)",
  );
});

test("deleteDatabase cascades schedules and SET NULLs run history (no orphans)", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  const s3 = await seedS3(db, { id: "s3_1" });
  // A schedule targeting the db (CASCADE) + a run referencing it (SET NULL).
  await seedBackup(db, { id: "bkp_1", destinationId: s3, databaseId: "db_1" });
  await seedRun(db, {
    id: "brun_1",
    destinationId: s3,
    databaseId: "db_1",
    backupId: "bkp_1",
  });

  // `force` is the "this host is never coming back" path: the teardown still runs
  // (and fails - no agent), but its failure no longer blocks the record delete.
  // This also proves the agent call is OUTSIDE the delete (a thrown dial can't
  // roll the row removal back).
  await asUser1(() => deleteDatabase("db_1", { force: true }));

  assert.equal(
    (
      await db
        .select()
        .from(databasesTable)
        .where(eq(databasesTable.id, "db_1"))
    ).length,
    0,
    "database row deleted",
  );
  assert.equal(
    (await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1")))
      .length,
    0,
    "dependent schedule CASCADE-deleted",
  );
  const run = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "brun_1"));
  assert.equal(run.length, 1, "run history survives");
  assert.equal(run[0]!.databaseId, null, "run.databaseId SET NULL");

  // A forced delete leaves real leftovers on the host, so it must leave a durable
  // trace of them (the activity log, not just a process warning), and it must
  // queue the teardown rather than hand the cleanup to a human.
  const queuedRows = await db.select().from(pendingTeardownsTable);
  assert.deepEqual(
    queuedRows.map((r) => [r.deployKey, r.projectLabel]),
    [["db-main", "db_1"]],
    "the forced delete queued the leftover stack",
  );
  const logged = await db.select().from(activitiesTable);
  assert.ok(
    logged.some(
      (a) =>
        a.message.includes("main") &&
        a.message.includes("will retry the teardown"),
    ),
    `forced delete records the leftovers, got: ${logged.map((a) => a.message).join(" | ")}`,
  );
});

// The cross-host volume copy that backs a server MOVE operates on the DB's real
// host-side Docker volume name. dbVolumeHostName must equal what the rendered DB
// compose ACTUALLY produces on the host, or a move would export/import the wrong
// (non-existent) volume and silently migrate nothing. Pin it AND cross-check it
// against the compose renderer + the same prefix logic project backups use, so the
// three can never drift.
test("dbVolumeHostName matches the rendered DB compose volume (move copies the right volume)", () => {
  const slug = "db-mydb";
  // The literal contract the agent's ExportVolume/ImportVolume receive.
  assert.equal(dbVolumeHostName(slug), "deplo-db-mydb_db-mydb-data");

  // Cross-check: derive the host volume name(s) from the ACTUAL rendered compose
  // exactly as buildProjectDescriptor does for a compose-stack backup. The DB
  // stack declares one unnamed volume, so this yields the single data volume, and
  // it must equal dbVolumeHostName. If someone changes the compose (e.g. pins a
  // `name:` on the volume), this fails loudly instead of breaking moves silently.
  const yaml = generateDatabaseCompose({
    network: "deplo-team-team_test",
    name: slug,
    databaseId: "db_test",
    type: "postgres",
    version: "16",
    username: "app",
    password: "pw",
    dbName: "db-mydb",
  });
  const derived = composeStackVolumeHostNames(slug, yaml);
  assert.deepEqual(derived, [dbVolumeHostName(slug)]);
});

/* ------------------------------------------------------------------ */
/* Focused post-create mutations (the database detail page)            */
/* ------------------------------------------------------------------ */

test("updateDatabaseResources: validates, persists, and round-trips via the DTO", async () => {
  await seedDatabase(db, { id: "db_lim", name: "lim" });
  await asUser1(async () => {
    await updateDatabaseResources("db_lim", { memoryMb: 512, cpuMilli: 500 });
    const dto = await getDatabase("db_lim");
    assert.equal(dto?.resources?.memoryMb, 512);
    assert.equal(dto?.resources?.cpuMilli, 500);
    assert.equal(dto?.resources?.pidsLimit, null);

    // Clearing every field folds back to resources: null (no limits set).
    await updateDatabaseResources("db_lim", {});
    assert.equal((await getDatabase("db_lim"))?.resources, null);

    // The shared validator runs on this path too: swap without memory is the
    // apps rule, verbatim.
    await assert.rejects(
      updateDatabaseResources("db_lim", { swapMb: 1024 }),
      /memory limit before a swap limit/,
    );
  });
});

test("updateDatabaseResources: a cross-team id hits 0 rows (Not found)", async () => {
  await seedDatabase(db, { id: "db_foreign", teamId: TEAM_B, name: "foreign" });
  await asUser1(async () => {
    await assert.rejects(
      updateDatabaseResources("db_foreign", { memoryMb: 256 }),
      /Not found/,
    );
  });
});

test("updateDatabaseImage: set + clear round-trip, syntax rejected", async () => {
  await seedDatabase(db, { id: "db_img", name: "img" });
  await asUser1(async () => {
    await updateDatabaseImage("db_img", {
      customImage: "timescale/timescaledb:2-pg16",
      customCommand: "postgres -c shared_buffers=256MB",
      version: "16.3",
    });
    let dto = await getDatabase("db_img");
    assert.equal(dto?.customImage, "timescale/timescaledb:2-pg16");
    assert.equal(dto?.customCommand, "postgres -c shared_buffers=256MB");
    assert.equal(dto?.version, "16.3");

    // Explicit null clears; absent fields stay untouched.
    await updateDatabaseImage("db_img", { customImage: null });
    dto = await getDatabase("db_img");
    assert.equal(dto?.customImage, null);
    assert.equal(dto?.customCommand, "postgres -c shared_buffers=256MB");

    await assert.rejects(
      updateDatabaseImage("db_img", { customImage: "bad image ref" }),
      /plain image reference/,
    );
    await assert.rejects(
      updateDatabaseImage("db_img", { customCommand: "line1\nline2" }),
      /single line/,
    );
    await assert.rejects(
      updateDatabaseImage("db_img", { version: "not a tag!" }),
      /valid image tag/,
    );
  });
});

test("restart/redeploy/rebuild: gated while provisioning with the curated message", async () => {
  await seedDatabase(db, {
    id: "db_prov",
    name: "prov",
    status: "provisioning",
  });
  await asUser1(async () => {
    await assert.rejects(restartDatabase("db_prov"), /still provisioning/);
    await assert.rejects(redeployDatabase("db_prov"), /still provisioning/);
    await assert.rejects(rebuildDatabase("db_prov"), /still provisioning/);
  });
});

// The destructive rebuild dials the agent BEFORE any write: an unreachable
// host must fail clearly with the row (and its status) untouched, nothing was
// torn down, so flipping status would lie.
test("rebuildDatabase: unreachable agent fails clearly and leaves the row intact", async () => {
  await seedDatabase(db, { id: "db_rb", name: "rb" });
  await asUser1(async () => {
    await assert.rejects(rebuildDatabase("db_rb"));
    const dto = await getDatabase("db_rb");
    assert.ok(dto, "row survives the failed rebuild");
    assert.equal(
      dto.status,
      "running",
      "status untouched - nothing was torn down",
    );
  });
});

test("rebuild/redeploy refuse to render an undecryptable password (no empty-auth engine)", async () => {
  // Simulate a `DEPLO_SECRET` rotation: the stored ciphertext no longer opens under
  // the running key. The guard runs BEFORE the agent dial, so the failure is the
  // decrypt message, not "unreachable agent".
  await seedDatabase(db, { id: "db_undec", name: "undec" });
  await db
    .update(databasesTable)
    // v1-shaped but the auth tag won't verify → tryDecryptSecret returns not-ok.
    .set({
      connectionStringEnc: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA",
    })
    .where(eq(databasesTable.id, "db_undec"));
  await asUser1(async () => {
    await assert.rejects(rebuildDatabase("db_undec"), /could not be decrypted/);
    await assert.rejects(
      redeployDatabase("db_undec"),
      /could not be decrypted/,
    );
    // Nothing was torn down or dialed - the row is exactly as seeded.
    assert.equal((await getDatabase("db_undec"))!.status, "running");
  });
});

test("rotateDatabasePassword: requires a running database and a policy-clean password", async () => {
  await seedDatabase(db, { id: "db_rot", name: "rot", status: "stopped" });
  await asUser1(async () => {
    await assert.rejects(
      rotateDatabasePassword("db_rot"),
      /Start the database/,
    );
    // A password the PERSON chose gets the account policy, like every other
    // chosen credential. The generated default (no argument) does not - it is
    // base64url and would fail "at least 1 special character" a third of the time.
    await assert.rejects(
      rotateDatabasePassword("db_rot", { password: "weakpass" }),
      /at least/i,
    );
    // A quote is no longer refused for its own sake: `rotationExecCommand`
    // quotes the value instead of pasting it into a shell string, so this gets
    // as far as the status check like any other valid password.
    await assert.rejects(
      rotateDatabasePassword("db_rot", { password: "With'Quote1!" }),
      /Start the database/,
    );
  });
});

test("focused mutations reject a member without manage_infra", async () => {
  // Re-seed identity with an extra low-capability member (the server row from
  // beforeEach survives the identity truncate - servers are cross-team).
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "user_viewer",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view"],
      },
    ],
  });
  await seedDatabase(db, { id: "db_cap", name: "cap" });
  await runWithIdentity({ userId: "user_viewer", teamId: TEAM_A }, async () => {
    await assert.rejects(updateDatabaseResources("db_cap", { memoryMb: 256 }));
    await assert.rejects(updateDatabaseImage("db_cap", { version: "16" }));
    await assert.rejects(restartDatabase("db_cap"));
    await assert.rejects(redeployDatabase("db_cap"));
    await assert.rejects(rebuildDatabase("db_cap"));
    await assert.rejects(rotateDatabasePassword("db_cap"));
  });
});

test("reorderDatabases persists a team order that listDatabases honours", async () => {
  // Three databases, created oldest→newest so the default sort is c, b, a.
  await seedDatabase(db, { id: "db_a", name: "aaa" });
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-01-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_a"));
  await seedDatabase(db, { id: "db_b", name: "bbb" });
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_b"));
  await seedDatabase(db, { id: "db_c", name: "ccc" });
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_c"));

  await asUser1(async () => {
    // Default: newest-first.
    assert.deepEqual(
      (await listDatabases()).map((d) => d.id),
      ["db_c", "db_b", "db_a"],
    );

    // Persist an explicit order; listDatabases must follow it.
    await reorderDatabases(["db_a", "db_c", "db_b"]);
    assert.deepEqual(
      (await listDatabases()).map((d) => d.id),
      ["db_a", "db_c", "db_b"],
    );

    // A partial order pins the listed ids first (in order); the omitted one
    // falls back to newest-first after them.
    await reorderDatabases(["db_b"]);
    assert.deepEqual(
      (await listDatabases()).map((d) => d.id),
      ["db_b", "db_c", "db_a"],
    );

    // Unknown/foreign ids are dropped, not stored.
    await reorderDatabases(["db_nope", "db_a"]);
    assert.deepEqual(
      (await listDatabases()).map((d) => d.id),
      ["db_a", "db_c", "db_b"],
    );
  });
});

test("reorderDatabases self-heals on delete (FK cascade) and rejects without manage_infra", async () => {
  await seedDatabase(db, { id: "db_x", name: "xxx" });
  await seedDatabase(db, { id: "db_y", name: "yyy" });
  await asUser1(async () => {
    await reorderDatabases(["db_y", "db_x"]);
    // Deleting an ordered database must not leave its id in the order table.
    await db.delete(databasesTable).where(eq(databasesTable.id, "db_y"));
    assert.deepEqual(
      (await listDatabases()).map((d) => d.id),
      ["db_x"],
    );
  });

  // A member without manage_infra can't reorder.
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "user_viewer2",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view"],
      },
    ],
  });
  await seedDatabase(db, { id: "db_z", name: "zzz" });
  await runWithIdentity(
    { userId: "user_viewer2", teamId: TEAM_A },
    async () => {
      await assert.rejects(reorderDatabases(["db_z"]));
    },
  );
});

/* ------------------------------------------------------------------ */
/* Identity: rename + logo (Settings → General)                        */
/* ------------------------------------------------------------------ */

// The headline invariant of renaming: the DISPLAY name changes and NOTHING
// physical does. `host` is the compose project / data volume / DNS name and it
// is baked into the connection string, so if a rename ever touched it, every
// client DSN would break and the next reroute would adopt a different volume.
test("renameDatabase changes only the display name - host and connection string are untouched", async () => {
  await seedDatabase(db, { id: "db_r", name: "main" });
  await asUser1(async () => {
    const before = await getDatabase("db_r");
    await renameDatabase("db_r", "  Primary Store  ");
    const after = await getDatabase("db_r");
    // Trimmed, but otherwise free-form: spaces and capitals survive (it is a
    // label, not an identifier).
    assert.equal(after?.name, "Primary Store");
    assert.equal(after?.host, before?.host, "host slug frozen");
    assert.equal(
      after?.connectionStringMasked,
      before?.connectionStringMasked,
      "connection string unaffected",
    );
    assert.equal(
      await getConnectionString("db_r"),
      await getConnectionString("db_r"),
    );
  });
  const logged = await db.select().from(activitiesTable);
  assert.ok(
    logged.some((a) => a.message === "Renamed database main to Primary Store"),
    `rename is recorded, got: ${logged.map((a) => a.message).join(" | ")}`,
  );
});

test("renameDatabase: validates, refuses a duplicate, no-ops on an unchanged name", async () => {
  await seedDatabase(db, { id: "db_n1", name: "alpha" });
  await seedDatabase(db, { id: "db_n2", name: "beta" });
  await asUser1(async () => {
    await assert.rejects(renameDatabase("db_n1", "   "), /name is required/i);
    await assert.rejects(
      renameDatabase("db_n1", "x".repeat(61)),
      /60 characters/,
    );
    // The team-unique index reads as a sentence, not a raw pg violation.
    await assert.rejects(
      renameDatabase("db_n1", "beta"),
      /already exists in this team/,
    );

    // Unchanged name: no write, and no activity row for a no-op Save.
    const activityBefore = (await db.select().from(activitiesTable)).length;
    await renameDatabase("db_n1", "alpha");
    assert.equal(
      (await db.select().from(activitiesTable)).length,
      activityBefore,
    );
  });
});

test("renameDatabase: a cross-team id is Not found", async () => {
  await seedDatabase(db, { id: "db_other", teamId: TEAM_B, name: "theirs" });
  await asUser1(async () => {
    await assert.rejects(renameDatabase("db_other", "mine"), /Not found/);
  });
  // The foreign row kept its name.
  const rows = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_other"));
  assert.equal(rows[0]!.name, "theirs");
});

test("updateDatabaseLogo: set, clear, validate, and stay team-scoped", async () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await seedDatabase(db, { id: "db_l", name: "logo" });
  await asUser1(async () => {
    // Born with no logo of its own - the UI falls back to the engine's mark.
    assert.equal((await getDatabase("db_l"))?.logo, null);

    await updateDatabaseLogo("db_l", png);
    assert.equal((await getDatabase("db_l"))?.logo, png);

    // Only the same grammar an app logo accepts: no remote URLs, no scripts.
    await assert.rejects(
      updateDatabaseLogo("db_l", "https://example.com/evil.svg"),
      /Unsupported logo image/,
    );
    assert.equal(
      (await getDatabase("db_l"))?.logo,
      png,
      "rejected value not stored",
    );

    // Clearing goes back to the engine mark.
    await updateDatabaseLogo("db_l", null);
    assert.equal((await getDatabase("db_l"))?.logo, null);
  });

  await seedDatabase(db, { id: "db_lf", teamId: TEAM_B, name: "foreign-logo" });
  await asUser1(async () => {
    await assert.rejects(updateDatabaseLogo("db_lf", png), /Not found/);
  });
});

/* ------------------------------------------------------------------ */
/* The rotation command: hostile passwords stay literals               */
/* ------------------------------------------------------------------ */

/**
 * The password lands in a command line the agent may run through a shell
 * (`ExecRequest.command` is documented as "shell-interpreted or argv"), so a
 * value that closes a quote used to be arbitrary code execution inside the
 * database container for anyone holding `configure_databases`, which does NOT
 * include `open_database_console`.
 *
 * The command is now assembled with shell/SQL quoting instead of a character
 * blocklist, and this proves it by running the result through a REAL shell: what
 * comes out has to be the statement, byte for byte, and nothing else may run.
 */
test("rotationExecCommand: a hostile password never escapes its quotes", () => {
  const db = {
    type: "postgres",
    username: "app",
    dbName: "db_x",
  } as unknown as Parameters<typeof rotationExecCommand>[0];

  for (const pw of [
    `a'; id; echo '`,
    `x" ; id ; echo "`,
    "$(id)",
    "`id`",
    `a'\\''b`,
    "; rm -rf /nope ;",
    "plain-P4ss!",
  ]) {
    const cmd = rotationExecCommand(db, "old-pw", pw)!;
    // What a POSIX shell would hand psql as its `-c` argument.
    const argv = execFileSync(
      "sh",
      ["-c", `${cmd.replace(/^psql /, "printf '%s' ")}`],
      { encoding: "utf8" },
    );
    assert.equal(
      argv.includes("uid="),
      false,
      `command substitution ran for ${JSON.stringify(pw)}`,
    );
    assert.ok(
      argv.endsWith(`WITH PASSWORD '${pw.replace(/'/g, "''")}'`),
      `unexpected statement for ${JSON.stringify(pw)}: ${argv}`,
    );
  }
});

// MariaDB 11 removed the `mysql*` compatibility symlinks its images used to
// ship, so the client only answers to its own name there. Emitting `mysql` meant
// password rotation on a MariaDB 11 failed with "executable file not found",
// which reads like the container is broken rather than like deplo typed the
// wrong program name.
test("rotationExecCommand: mariadb is driven by the mariadb client, mysql by mysql", () => {
  const base = { username: "app", dbName: "db_x" };
  const maria = rotationExecCommand(
    { ...base, type: "mariadb" } as unknown as Parameters<
      typeof rotationExecCommand
    >[0],
    "old",
    "new",
  )!;
  const mysql = rotationExecCommand(
    { ...base, type: "mysql" } as unknown as Parameters<
      typeof rotationExecCommand
    >[0],
    "old",
    "new",
  )!;
  assert.ok(maria.startsWith("mariadb -uroot "), maria);
  assert.ok(mysql.startsWith("mysql -uroot "), mysql);
  // Both still rotate root AND the application user, whichever client runs it.
  // (The statement is shell-quoted, so match on the parts, not the raw SQL.)
  for (const cmd of [maria, mysql]) {
    assert.equal((cmd.match(/ALTER USER IF EXISTS/g) ?? []).length, 3, cmd);
    assert.match(cmd, /root/);
    assert.match(cmd, /app/);
    assert.match(cmd, /FLUSH PRIVILEGES/);
  }
});

/* ------------------------------------------------------------------ */
/* Whose password is it: chosen vs. generated                          */
/* ------------------------------------------------------------------ */

/**
 * The account policy bounds a password a PERSON chose. An import carries
 * another platform's generated token, and running the policy over that one
 * refused practically every Dokploy database (they are alphanumeric, so "at
 * least 1 special character" alone was enough) - after which the import minted
 * a fresh password and every connection string that still spells out the old
 * one stopped working. What the connection string itself cannot carry stays
 * refused on both paths: that check is about the URL and the env-file, not
 * about strength.
 */
test("createDatabase: the password policy is for a chosen password, not an imported one", async () => {
  await asUser1(async () => {
    const input = {
      name: "imported",
      type: "postgres" as const,
      version: "16",
      password: "dokploygeneratedpw1A",
    };
    await assert.rejects(() => createDatabase(input), /special character/);
    await assert.rejects(
      () => createDatabase({ ...input, passwordIsGenerated: true }),
      (e: Error) => !/special character/.test(e.message),
    );
    // What the env line genuinely cannot carry stays refused on both paths.
    await assert.rejects(
      () =>
        createDatabase({
          ...input,
          password: "has a space",
          passwordIsGenerated: true,
        }),
      /may not contain/,
    );
    await assert.rejects(
      () =>
        createDatabase({
          ...input,
          password: "interpolated$HOME",
          passwordIsGenerated: true,
        }),
      /may not contain/,
    );
  });
});

/**
 * A host port is a singleton on the machine, and the agent's bind probe cannot
 * see one that has been CLAIMED but is not yet listening.
 *
 * Two databases created in a row - which is exactly what an import does, several
 * at once, each carrying the port it had on the other platform - both passed that
 * probe, because the first one's container is provisioned in the background and
 * has not bound anything yet. Both rows were written, and whichever started
 * second failed at `compose up` with nobody having been told. The row is the
 * second half of the check, and it is the half nothing had.
 */
test("a host port another database has reserved is refused before anything listens", async () => {
  await seedServerRow(db, {
    id: "srv_ports",
    name: "ports-1",
    ip: "10.0.0.7",
    host: "10.0.0.7",
    agent: {
      port: 9443,
      certFingerprint: "sha256:pinned",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.20.0",
    },
  });
  await db.execute(
    `update users set can_expose_ports = true where id = '${USER_1}'`,
  );
  // Everything is free ON THE HOST, so the row is the only thing that can refuse.
  const probed: number[] = [];
  __setAgentConnectorForTest(
    async () =>
      ({
        checkPort: async (port: number) => {
          probed.push(port);
          return { available: true, reason: "" };
        },
        reroute: async () => ({ ok: true, error: "" }),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );
  try {
    await asUser1(async () => {
      const base = {
        type: "postgres" as const,
        version: "16",
        serverId: "srv_ports",
        exposedPublicly: true,
      };
      await createDatabase({ ...base, name: "first", exposedPort: 25432 });
      await assert.rejects(
        () => createDatabase({ ...base, name: "second", exposedPort: 25432 }),
        /already in use/,
      );
      // A different port on the same host is untouched by any of this.
      const ok = await createDatabase({
        ...base,
        name: "third",
        exposedPort: 25433,
      });
      assert.equal(ok.exposedPort, 25433);
      assert.ok(probed.includes(25432), "the host was still asked");
    });
    // Drained HERE, not in the next beforeEach: the runner attributes async work
    // to the test that started it, so provisioning still in flight when this one
    // returns fails THIS test however tidily the next one cleans up.
    await settleProvisioning(db);
  } finally {
    __setAgentConnectorForTest();
  }
});

/**
 * The same reservation, seen from the other side: `hostPortsInUse` is what the
 * import review reads before it offers anybody a choice, so it has to answer for
 * a claimed-but-idle port too - and it must never THROW for an agent that cannot
 * answer, or a migration would stop on a probe.
 */
test("hostPortsInUse reports claimed ports, and says so when it cannot ask", async () => {
  await seedServerRow(db, {
    id: "srv_probe",
    name: "probe-1",
    ip: "10.0.0.8",
    host: "10.0.0.8",
    agent: {
      port: 9443,
      // Its OWN fingerprint: `servers` is partial-unique on that column and the
      // seed swallows a conflict, so two servers sharing one would leave the
      // second row silently absent.
      certFingerprint: "sha256:probe",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.20.0",
    },
  });
  await db.execute(
    `update users set can_expose_ports = true where id = '${USER_1}'`,
  );
  await seedDatabase(db, {
    id: "db_claim",
    name: "claimer",
    serverId: "srv_probe",
    exposedPublicly: true,
    exposedPort: 25500,
  });
  __setAgentConnectorForTest(
    async () =>
      ({
        // 5432 is a real listener; everything else on this host is free.
        checkPort: async (port: number) => ({
          available: port !== 5432,
          reason: "",
        }),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );
  try {
    await asUser1(async () => {
      const res = await hostPortsInUse(
        "srv_probe",
        [5432, 25500, 25501, 25501],
      );
      assert.equal(res.checked, true);
      assert.deepEqual(
        res.inUse.sort((a, b) => a - b),
        [5432, 25500],
      );
    });
  } finally {
    __setAgentConnectorForTest();
  }

  // An agent that will not answer is not an error the caller has to handle: the
  // review says so once and carries on.
  __setAgentConnectorForTest(async () => {
    throw new Error("agent is too old to check ports");
  });
  try {
    await asUser1(async () => {
      const res = await hostPortsInUse("srv_probe", [5432]);
      assert.equal(res.checked, false);
      assert.deepEqual(res.inUse, []);
      assert.match(res.reason ?? "", /too old/);
    });
  } finally {
    __setAgentConnectorForTest();
  }
});

/* ------------------------------------------------------------------ */
/* config files                                                        */
/* ------------------------------------------------------------------ */

// The one path a config file must never take. A file inside the data directory
// is stored WITH the data: it travels into every backup, comes back on every
// restore, and on Postgres the entrypoint refuses to start at all.
test("a config file may not be mounted inside the engine's data directory", () => {
  assert.throws(
    () =>
      validateDatabaseMounts("postgres", [
        {
          filePath: "postgresql.conf",
          content: "",
          mountPath: "/var/lib/postgresql/data/postgresql.conf",
        },
      ]),
    /data directory/,
  );
  // The same file one level up is the normal, correct thing to do.
  assert.equal(
    validateDatabaseMounts("postgres", [
      {
        filePath: "postgresql.conf",
        content: "x",
        mountPath: "/etc/postgresql.conf",
      },
    ]).length,
    1,
  );
  // Each engine is judged against ITS OWN data dir, not postgres's.
  assert.throws(
    () =>
      validateDatabaseMounts("mysql", [
        { filePath: "my.cnf", content: "", mountPath: "/var/lib/mysql/my.cnf" },
      ]),
    /data directory/,
  );
  assert.equal(
    validateDatabaseMounts("mysql", [
      { filePath: "my.cnf", content: "x", mountPath: "/etc/my.cnf" },
    ]).length,
    1,
  );
});

test("a config file's two paths are each refused when they cannot work", () => {
  const one = (
    m: Partial<{ filePath: string; content: string; mountPath: string }>,
  ) =>
    validateDatabaseMounts("postgres", [
      { filePath: "pg.conf", content: "", mountPath: "/etc/pg.conf", ...m },
    ]);
  assert.throws(() => one({ filePath: "/etc/pg.conf" }), /must be relative/);
  assert.throws(() => one({ filePath: "../pg.conf" }), /\.\./);
  assert.throws(() => one({ mountPath: "etc/pg.conf" }), /must be absolute/);
  assert.throws(() => one({ mountPath: "/etc/pg.conf:ro" }), /spaces or/);
  assert.throws(
    () =>
      validateDatabaseMounts("postgres", [
        { filePath: "a.conf", content: "", mountPath: "/etc/a.conf" },
        { filePath: "a.conf", content: "", mountPath: "/etc/b.conf" },
      ]),
    /Duplicate file name/,
  );
  assert.throws(
    () =>
      validateDatabaseMounts("postgres", [
        { filePath: "a.conf", content: "", mountPath: "/etc/a.conf" },
        { filePath: "b.conf", content: "", mountPath: "/etc/a.conf" },
      ]),
    /Duplicate path/,
  );
});

// Saving APPLIES: the files reach the agent in the same call that stores them,
// and the rendered stack binds them. A save that only wrote rows would leave the
// running engine reading its old configuration with the UI saying otherwise.
test("saving config files reroutes the stack with them", async () => {
  await seedDatabase(db, { id: "db_cfg", name: "cfg" });
  const sent: { yaml: string; mounts: { path: string; content: string }[] }[] =
    [];
  __setAgentConnectorForTest(
    async () =>
      ({
        reroute: async (r: {
          composeYaml: string;
          mounts: { path: string; content: string }[];
        }) => {
          sent.push({ yaml: r.composeYaml, mounts: r.mounts });
          return { ok: true, error: "" };
        },
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );
  try {
    await asUser1(async () => {
      await setDatabaseMounts("db_cfg", [
        {
          filePath: "postgresql.conf",
          content: "shared_buffers = 1GB\n",
          mountPath: "/etc/postgresql.conf",
        },
      ]);
      const saved = await getDatabase("db_cfg");
      assert.deepEqual(saved?.mounts, [
        {
          filePath: "postgresql.conf",
          content: "shared_buffers = 1GB\n",
          mountPath: "/etc/postgresql.conf",
        },
      ]);
    });
    assert.equal(sent.length, 1, "the save applied");
    assert.deepEqual(sent[0]!.mounts, [
      { path: "postgresql.conf", content: "shared_buffers = 1GB\n" },
    ]);
    assert.ok(
      sent[0]!.yaml.includes(
        "/files/db-cfg/postgresql.conf:/etc/postgresql.conf",
      ),
      sent[0]!.yaml,
    );

    // And a redeploy afterwards carries them too - the trap being a reroute path
    // that renders from the row but ships no files, leaving docker to invent an
    // empty DIRECTORY at the bind source.
    await asUser1(() => redeployDatabase("db_cfg"));
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1]!.mounts, sent[0]!.mounts);
  } finally {
    __setAgentConnectorForTest(undefined);
  }
});

// The whole set is replaced, so removing a file removes its mount.
test("clearing the config files reroutes a stack with none", async () => {
  await seedDatabase(db, {
    id: "db_clear",
    name: "clear",
    mounts: [{ filePath: "pg.conf", content: "x", mountPath: "/etc/pg.conf" }],
  });
  const sent: { path: string; content: string }[][] = [];
  __setAgentConnectorForTest(
    async () =>
      ({
        reroute: async (r: { mounts: { path: string; content: string }[] }) => {
          sent.push(r.mounts);
          return { ok: true, error: "" };
        },
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );
  try {
    await asUser1(async () => {
      assert.equal((await getDatabase("db_clear"))?.mounts.length, 1);
      await setDatabaseMounts("db_clear", []);
      assert.deepEqual((await getDatabase("db_clear"))?.mounts, []);
    });
    assert.deepEqual(sent, [[]]);
  } finally {
    __setAgentConnectorForTest(undefined);
  }
});

test("publishing a port is refused without the canExposePorts grant", async () => {
  await seedDatabase(db, { id: "db_1", name: "one" });

  await runWithIdentity({ userId: USER_MEMBER, teamId: TEAM_A }, async () => {
    await assert.rejects(
      () =>
        updateDatabase("db_1", {
          exposedPublicly: true,
          exposedPort: 25432,
        }),
      /permission to publish ports/i,
    );
  });

  const [row] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_1"));
  assert.equal(row.exposedPublicly, false);
  assert.equal(row.exposedPort, null);
});
