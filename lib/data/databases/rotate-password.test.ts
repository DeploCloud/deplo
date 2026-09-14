import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { seedDatabase, settleProvisioning } from "../backup-test-helpers";
import { rotateDatabasePassword, rotationExecCommand } from "./rotate-password";
import { asUser1, seedBase } from "./databases-test-helpers";

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
  await settleProvisioning(db);
  await seedBase(db, pg);
});

test("rotateDatabasePassword: requires a running database and a policy-clean password", async () => {
  await seedDatabase(db, { id: "db_rot", name: "rot", status: "stopped" });
  await asUser1(async () => {
    await assert.rejects(
      rotateDatabasePassword("db_rot"),
      /Start the database/,
    );
    // Only a password a PERSON chose gets the policy: the generated default is
    // base64url and would fail "at least 1 special character" a third of the time.
    await assert.rejects(
      rotateDatabasePassword("db_rot", { password: "weakpass" }),
      /at least/i,
    );
    await assert.rejects(
      rotateDatabasePassword("db_rot", { password: "With'Quote1!" }),
      /Start the database/,
    );
  });
});

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

// MariaDB 11 removed the `mysql*` compatibility symlinks, so the client only answers to its own name.
// Emitting `mysql` there broke rotation with "executable file not found", which reads
// like the container is broken rather than like Deplo named the wrong program.
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
  for (const cmd of [maria, mysql]) {
    assert.equal((cmd.match(/ALTER USER IF EXISTS/g) ?? []).length, 3, cmd);
    assert.match(cmd, /root/);
    assert.match(cmd, /app/);
    assert.match(cmd, /FLUSH PRIVILEGES/);
  }
});
