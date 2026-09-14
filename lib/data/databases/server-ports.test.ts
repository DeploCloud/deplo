import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { seedDatabase, settleProvisioning } from "../backup-test-helpers";
import { createDatabase } from "./provision";
import { hostPortsInUse } from "./server-ports";
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
        ReturnType<
          typeof import("../../infra/agent-client/connect").connectAgent
        >
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
      const ok = await createDatabase({
        ...base,
        name: "third",
        exposedPort: 25433,
      });
      assert.equal(ok.exposedPort, 25433);
      assert.ok(probed.includes(25432), "the host was still asked");
    });
    await settleProvisioning(db);
  } finally {
    __setAgentConnectorForTest();
  }
});

test("hostPortsInUse reports claimed ports, and says so when it cannot ask", async () => {
  await seedServerRow(db, {
    id: "srv_probe",
    name: "probe-1",
    ip: "10.0.0.8",
    host: "10.0.0.8",
    agent: {
      port: 9443,
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
        checkPort: async (port: number) => ({
          available: port !== 5432,
          reason: "",
        }),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<
          typeof import("../../infra/agent-client/connect").connectAgent
        >
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
