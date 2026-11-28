import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import {
  BACKUP_CAPABILITY,
  BACKUP_STORE_CAPABILITY,
  VOLUME_USAGE_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";
import type { BackupDestination } from "../../types/backup";
import { seedServerRow } from "../infra-test-helpers";
import { roomForBackup } from "./room";

let db: TestDb;
let pg: PGlite;
const GiB = 1 << 30;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  await seedServerRow(db, { id: "srv_dst", name: "eu-1" });
});
after(async () => {
  __resetTestDb();
  await pg.close();
});
afterEach(() => __setAgentConnectorForTest());

const hello = async () => ({
  capabilities: [
    BACKUP_CAPABILITY,
    BACKUP_STORE_CAPABILITY,
    VOLUME_USAGE_CAPABILITY,
  ],
});

function fleet(free: number, total: number) {
  const source = {
    hello,
    close() {},
    volumeUsage: async (names: string[]) =>
      new Map(names.map((n) => [n, GiB] as [string, number])),
  } as unknown as AgentConnection;
  const sink = {
    hello,
    close() {},
    storeCheck: async () => ({
      ok: true,
      error: "",
      freeBytes: free,
      totalBytes: total,
      root: "/var/lib/deplo-agent/backups",
    }),
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async (id) =>
    id === "srv_src" ? source : id === "srv_dst" ? sink : null,
  );
}

const creds = (kind: "server" | "s3") => ({
  destination: {
    kind,
    serverId: "srv_dst",
    path: "/backups",
  } as BackupDestination,
  accessKey: "",
  secretKey: "",
  ageIdentity: "",
});
const app = {
  serverId: "srv_src",
  kind: "app" as const,
  project: {
    slug: "lab-b2g",
    volumeNames: ["deplo-lab-b2g-data", "deplo-lab-b2g-cache"],
  } as never,
};

// eu, 24 Nov 2026: a relayed 2 GB backup nearly filled eu-1. A backup now starts only when what it writes leaves a
// tenth of the destination's disk free, and the run says why when it does not.
test("a backup that would leave less than a tenth of the destination's disk free does not start", async () => {
  fleet(2.5 * GiB, 14 * GiB);
  const why = await roomForBackup(creds("server"), app, "prj_b2g");
  assert.match(
    why ?? "",
    /^eu-1 has 2\.5 GB free, too little for this backup \(about 2\.0 GB\) and a tenth of its disk free, so it did not start$/,
  );
});

test("a backup that fits with a tenth of the disk to spare starts", async () => {
  fleet(5 * GiB, 14 * GiB);
  assert.equal(await roomForBackup(creds("server"), app, "prj_b2g"), null);
});

test("a bucket has no disk to fill", async () => {
  fleet(0, 14 * GiB);
  assert.equal(await roomForBackup(creds("s3"), app, "prj_b2g"), null);
});
