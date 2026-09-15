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
import {
  prepareUploadRestore,
  uploadRestoreRefusal,
} from "./backups/upload-restore";

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

function bodyOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function appArtifact(): Buffer {
  const tar = Buffer.alloc(4096);
  tar.write("volumes/data/deplo.db", 0);
  tar.write("ustar", 257);
  return zlib.gzipSync(tar);
}

function databaseArtifact(): Buffer {
  const dump = Buffer.alloc(4096);
  dump.write("PGDMP", 0);
  return zlib.gzipSync(dump);
}

async function encryptedAppArtifact(): Promise<{
  artifact: Buffer;
  key: string;
}> {
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
    /not an app backup/,
  );
});

test("an app with no stack on its host refuses an uploaded archive", () => {
  assert.match(
    uploadRestoreRefusal({ kind: "app", project: { composeYaml: "" } }) ?? "",
    /never been deployed/,
  );
  assert.match(
    uploadRestoreRefusal({ kind: "app" }) ?? "",
    /never been deployed/,
  );
});

test("an app with a live stack proceeds, and a database is never in scope", () => {
  assert.equal(
    uploadRestoreRefusal({
      kind: "app",
      project: { composeYaml: "services: {}" },
    }),
    null,
  );
  assert.equal(uploadRestoreRefusal({ kind: "database" }), null);
});
