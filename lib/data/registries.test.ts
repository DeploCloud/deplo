import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { registries as registriesTable } from "../db/schema/control-plane";
import { decryptSecret } from "../crypto";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./leaf-test-helpers";
import { addRegistry, deleteRegistry, listRegistries } from "./registries";

/**
 * Data-layer tests for `registries` against pglite (PLAN Step 2). Verifies the
 * newest-first SQL sort, that the password is stored encrypted and never in the
 * DTO, and that delete is team-scoped.
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
  await pg.exec(`truncate table registries, users, teams restart identity cascade;`);
  // Two owners: user_1 in alpha, user_2 in beta (for the cross-team delete check).
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("addRegistry stores an encrypted password; the DTO carries no secret", async () => {
  await asUser1(async () => {
    await addRegistry({
      name: "GHCR",
      type: "ghcr",
      username: "alpha",
      password: "s3cret",
    });
    const list = await listRegistries();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.registryUrl, "ghcr.io", "default host for ghcr");
    assert.equal("passwordEnc" in list[0]!, false, "no secret in the DTO");
  });

  const rows = await db.select().from(registriesTable);
  assert.notEqual(rows[0]!.passwordEnc, "s3cret", "stored encrypted, not plaintext");
  assert.equal(decryptSecret(rows[0]!.passwordEnc), "s3cret", "decrypts back to plaintext");
});

test("listRegistries returns newest-first", async () => {
  await asUser1(async () => {
    await addRegistry({ name: "first", type: "ghcr", username: "u", password: "p" });
    await new Promise((r) => setTimeout(r, 5));
    await addRegistry({ name: "second", type: "dockerhub", username: "u", password: "p" });
    const list = await listRegistries();
    assert.deepEqual(list.map((r) => r.name), ["second", "first"]);
  });
});

test("addRegistry validates required fields", async () => {
  await asUser1(async () => {
    await assert.rejects(
      () => addRegistry({ name: "", type: "ghcr", username: "u", password: "p" }),
      /Enter a name/,
    );
    await assert.rejects(
      () => addRegistry({ name: "x", type: "generic", username: "u", password: "p" }),
      /Enter the registry host/,
    );
  });
});

test("deleteRegistry removes only the active team's matching registry", async () => {
  // user_2 (team B) adds one; user_1 (team A) must not be able to delete it.
  await runWithIdentity({ userId: "user_2", teamId: TEAM_B }, async () => {
    await addRegistry({ name: "B-reg", type: "ghcr", username: "u", password: "p" });
  });
  const bRow = (await db.select().from(registriesTable))[0]!;

  await asUser1(async () => {
    await assert.rejects(() => deleteRegistry(bRow.id), /Registry not found/);
  });
  assert.equal((await db.select().from(registriesTable)).length, 1, "team-B row survives");

  await runWithIdentity({ userId: "user_2", teamId: TEAM_B }, async () => {
    await deleteRegistry(bRow.id);
  });
  assert.equal((await db.select().from(registriesTable)).length, 0);
});
