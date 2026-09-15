import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { seedDatabase, settleProvisioning } from "../backup-test-helpers";
import { setDatabaseMounts, validateDatabaseMounts } from "./mounts";
import { redeployDatabase } from "./lifecycle";
import { getDatabase } from "./rows";
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
        ReturnType<
          typeof import("../../infra/agent-client/connect").connectAgent
        >
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

    await asUser1(() => redeployDatabase("db_cfg"));
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1]!.mounts, sent[0]!.mounts);
  } finally {
    __setAgentConnectorForTest(undefined);
  }
});

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
        ReturnType<
          typeof import("../../infra/agent-client/connect").connectAgent
        >
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
