import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  TRUNCATE_IDENTITY,
  USER_1,
} from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { seedDatabase, TRUNCATE_BACKUPS } from "./backup-test-helpers";
import { prepareUploadRestore } from "./backups";

/**
 * `prepareUploadRestore` is the only restore that does not start from a run this
 * instance recorded, so it is also the only one whose input is entirely the
 * caller's. These tests cover the refusals - and specifically that every one of
 * them happens BEFORE an agent is dialed, which is what keeps a wrong file or a
 * wrong key from being discovered after the stack is stopped and the volumes are
 * wiped. None of them needs an agent, because none of them should ever reach one.
 */

let db: TestDb;
let pg: PGlite;

const USER_VIEWER = "user_viewer";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_BACKUPS}${TRUNCATE_IDENTITY}
    truncate table app_build_method_settings, app_build, apps, servers
      restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      // Everything backups-related EXCEPT the one that matters here.
      {
        id: USER_VIEWER,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_backups"],
      },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await seedApp(db, { id: "prj_other", teamId: TEAM_B });
  await seedDatabase(db, { id: "db_1", name: "main" });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asViewer = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_VIEWER, teamId: TEAM_A }, fn);

/** A body, as the route hands one over. */
function bodyOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** An app artifact: gzip of something with the tar magic where tar puts it. */
function appArtifact(): Buffer {
  const tar = Buffer.alloc(4096);
  tar.write("volumes/data/deplo.db", 0);
  tar.write("ustar", 257);
  return zlib.gzipSync(tar);
}

/** A database artifact: gzip of a dump, which is not a tar. */
function databaseArtifact(): Buffer {
  const dump = Buffer.alloc(4096);
  dump.write("PGDMP", 0);
  return zlib.gzipSync(dump);
}

async function encryptedAppArtifact(): Promise<{ artifact: Buffer; key: string }> {
  const age = await import("age-encryption");
  const key = await age.generateX25519Identity();
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(await age.identityToRecipient(key));
  return { artifact: Buffer.from(await encrypter.encrypt(appArtifact())), key };
}

test("a member without restore_backups is refused", async () => {
  await assert.rejects(
    () =>
      asViewer(() =>
        prepareUploadRestore({
          kind: "app",
          targetId: "prj_1",
          recoveryKey: "",
          body: bodyOf(appArtifact()),
        }),
      ),
    // `manage_backups` is not enough: a restore overwrites live data, which is
    // its own capability precisely so it can be withheld.
    /permission|not allowed/i,
  );
});

test("an app in another team is not found, not refused", async () => {
  await assert.rejects(
    () =>
      asUser1(() =>
        prepareUploadRestore({
          kind: "app",
          targetId: "prj_other",
          recoveryKey: "",
          body: bodyOf(appArtifact()),
        }),
      ),
    /not found/i,
  );
});

test("a file that is not a backup artifact never reaches the agent", async () => {
  await assert.rejects(
    () =>
      asUser1(() =>
        prepareUploadRestore({
          kind: "app",
          targetId: "prj_1",
          recoveryKey: "",
          body: bodyOf(Buffer.from("PK a zip of holiday photos")),
        }),
      ),
    /not a backup artifact/,
  );
});

test("an empty upload is refused", async () => {
  await assert.rejects(
    () =>
      asUser1(() =>
        prepareUploadRestore({
          kind: "app",
          targetId: "prj_1",
          recoveryKey: "",
          body: bodyOf(Buffer.alloc(0)),
        }),
      ),
    /is empty/,
  );
});

test("a database dump aimed at an app is refused before anything is wiped", async () => {
  await assert.rejects(
    () =>
      asUser1(() =>
        prepareUploadRestore({
          kind: "app",
          targetId: "prj_1",
          recoveryKey: "",
          body: bodyOf(databaseArtifact()),
        }),
      ),
    /not an app backup/,
  );
});

test("an app archive aimed at a database is refused", async () => {
  await assert.rejects(
    () =>
      asUser1(() =>
        prepareUploadRestore({
          kind: "database",
          targetId: "db_1",
          recoveryKey: "",
          body: bodyOf(appArtifact()),
        }),
      ),
    /app backup, not a database dump/,
  );
});

test("an encrypted artifact with no key, and with a wrong one, are told apart", async () => {
  const { artifact } = await encryptedAppArtifact();
  await assert.rejects(
    () =>
      asUser1(() =>
        prepareUploadRestore({
          kind: "app",
          targetId: "prj_1",
          recoveryKey: "",
          body: bodyOf(artifact),
        }),
      ),
    /Paste the recovery key/,
  );

  await assert.rejects(
    () =>
      asUser1(() =>
        prepareUploadRestore({
          kind: "app",
          targetId: "prj_1",
          recoveryKey: "not-a-key",
          body: bodyOf(artifact),
        }),
      ),
    /not a recovery key/,
  );

  const other = await encryptedAppArtifact();
  await assert.rejects(
    () =>
      asUser1(() =>
        prepareUploadRestore({
          kind: "app",
          targetId: "prj_1",
          recoveryKey: other.key,
          body: bodyOf(artifact),
        }),
      ),
    /does not open this file/,
  );
});

test("a refusal releases the lock, so the next attempt is judged on its own", async () => {
  // The lock is taken before the artifact is even read: a rejected file that
  // left it held would lock the operator out of their own retry.
  await assert.rejects(
    () =>
      asUser1(() =>
        prepareUploadRestore({
          kind: "app",
          targetId: "prj_1",
          recoveryKey: "",
          body: bodyOf(databaseArtifact()),
        }),
      ),
    /not an app backup/,
  );
  await assert.rejects(
    () =>
      asUser1(() =>
        prepareUploadRestore({
          kind: "app",
          targetId: "prj_1",
          recoveryKey: "",
          body: bodyOf(databaseArtifact()),
        }),
      ),
    // The same refusal, NOT "a restore is already running".
    /not an app backup/,
  );
});
