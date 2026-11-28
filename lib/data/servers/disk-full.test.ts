import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { recordMetricsSample } from "../../monitoring/history";
import type { ServerMetrics } from "../monitoring";
import { seedServerRow } from "../infra-test-helpers";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { diskFullSentence, diskWarnings, noteDiskUse } from "./disk-full";

let db: TestDb;
let pg: PGlite;
before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});
after(() => __resetTestDb());
beforeEach(async () => {
  await pg.exec(
    "truncate table activities, servers, users, teams restart identity cascade;",
  );
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServerRow(db, { id: "srv_4", name: "eu-4" });
});

const said = async () =>
  (await db.select().from(activities)).map((a) => a.message);

// eu, 24 Nov 2026: lab-grow, writing to its own volume, took eu-4 to 90% and nothing said so.
test("a disk past 90% is said once in Activity, and again only after it was back under", async () => {
  await noteDiskUse("srv_4", "eu-4", 91.2);
  await noteDiskUse("srv_4", "eu-4", 93);
  assert.deepEqual(await said(), [
    "eu-4's disk is 91% full. Free some space on it, or Apps there cannot write.",
  ]);
  await noteDiskUse("srv_4", "eu-4", 89);
  assert.equal((await said()).length, 1, "between 88% and 90% nothing changes");
  await noteDiskUse("srv_4", "eu-4", 70);
  await noteDiskUse("srv_4", "eu-4", 95);
  assert.equal((await said()).length, 2);
});

test("the warning names how full the disk is and what takes it, biggest first", async () => {
  assert.equal(
    diskFullSentence("eu-4", 92.7, [
      { name: "lab-grow", bytes: 1.6 * 1024 ** 3 },
      { name: "a copy of fise", bytes: 48 * 1024 ** 2 },
    ]),
    "eu-4's disk is 92% full. Biggest: lab-grow (1.6 GB), a copy of fise (48.0 MB). Free some space on it, or Apps there cannot write.",
  );
  const sample = {
    serverId: "srv_4",
    online: true,
    ts: Date.now(),
    diskPct: 92.7,
  } as ServerMetrics;
  recordMetricsSample(sample);
  const got = await diskWarnings([
    { id: "srv_4", name: "eu-4" },
    { id: "srv_x", name: "eu-x" },
  ]);
  assert.match(got.get("srv_4") ?? "", /^eu-4's disk is 92% full\./);
  assert.equal(got.has("srv_x"), false);
});
