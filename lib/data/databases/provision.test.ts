import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { pendingTeardowns as pendingTeardownsTable } from "../../db/schema/control-plane/deployments";
import { TEAM_B } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { settleProvisioning } from "../backup-test-helpers";
import { createDatabase } from "./provision";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
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

test("a database name whose stack is still being torn down on that host is taken", async () => {
  await seedServerRow(db, {
    id: "srv_td",
    name: "td-1",
    ip: "10.0.0.99",
    host: "10.0.0.99",
    agent: {
      port: 9443,
      certFingerprint: "sha256:td",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.20.0",
    },
  });
  await db.insert(pendingTeardownsTable).values({
    id: "ptd_db",
    serverId: "srv_td",
    deployKey: "db-main",
    projectLabel: "db_gone",
    label: "main",
    teamId: TEAM_B,
    nextAttemptAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await asUser1(() =>
    assert.rejects(
      () =>
        createDatabase({
          type: "postgres",
          version: "16",
          name: "main",
          serverId: "srv_td",
        }),
      /still being removed/,
    ),
  );
});

test("the default database name is a plain identifier, not the hyphenated host", async () => {
  await seedServerRow(db, {
    id: "srv_ch",
    name: "ch-1",
    ip: "10.0.0.98",
    host: "10.0.0.98",
    agent: {
      port: 9443,
      certFingerprint: "sha256:ch",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.20.0",
    },
  });
  __setAgentConnectorForTest(async () => {
    throw new Error("no agent in this test");
  });
  try {
    const created = await asUser1(() =>
      createDatabase({
        type: "clickhouse",
        version: "25.8",
        name: "shop-ch",
        serverId: "srv_ch",
      }),
    );
    await settleProvisioning(db);
    assert.equal(created.host, "db-shop-ch");
    assert.equal(
      created.dbName,
      "db_shop_ch",
      "ClickHouse refuses `-` in an unquoted name",
    );
  } finally {
    __setAgentConnectorForTest();
  }
});
