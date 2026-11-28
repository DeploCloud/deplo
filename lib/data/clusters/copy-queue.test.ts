import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  ClusterReplicaReport,
  ClusterReplicaTable,
} from "../../infra/agent-client/connection";
import { seedApp } from "../app-graph-test-helpers";
import { databaseLab, db } from "../cluster-database-test-helpers";
import { __forgetTurns, busyWith, takeTurn, turnWait } from "./copy-turns";
import { queuedCopies } from "./replication";

databaseLab();

const MB = 1024 * 1024;
const KIT: Record<string, string> = {
  "lab-kit-a": "srv_2",
  "lab-kit-b": "srv_4",
  "lab-kit-d": "srv_4",
};
const TABLE: ClusterReplicaTable = {
  clusterId: "clu_eu",
  members: ["srv_2", "srv_3", "srv_4"].map((serverId) => ({
    serverId,
    fingerprint: "",
  })),
  entries: Object.keys(KIT).map((appId) => ({
    appId,
    slug: appId,
    volumeNames: [`deplo-${appId}-data`],
    includeFiles: false,
  })),
};

const copy = (appId: string, mb: number, held = ""): ClusterReplicaReport => ({
  appId,
  role: held ? "idle" : "receiving",
  connected: !held,
  streams: 0,
  synced: true,
  appliedAt: held ? "" : new Date().toISOString(),
  bytes: mb * MB,
  error: held,
  fromServerId: KIT[appId]!,
});

// What server-3 receives: each kit App's copy at so many MB, or held whole by the queue.
let holds = new Map<string, string>();
async function pass(mb: Record<string, number>) {
  const reports = Object.keys(KIT).map((id) =>
    holds.has(id) ? copy(id, 64, holds.get(id)) : copy(id, mb[id] ?? 64),
  );
  const q = await queuedCopies(TABLE, new Map([["srv_3", reports]]), new Map());
  holds = q.holds.get("srv_3") ?? new Map();
  return busyWith("srv_3");
}

// c44: 140 MiB fills in lab-kit-a, -b and -d a second apart reached eu-3 as d, b, a; a's copy, started, was queued again.
test("copies into one server go first come, first served, and a started one keeps its turn", async () => {
  __forgetTurns();
  holds = new Map();
  for (const [id, serverId] of Object.entries(KIT))
    await seedApp(db, { id, serverId });
  const poll = turnWait.pollMs;
  turnWait.pollMs = 5;
  const stop = new AbortController();
  let backup: Promise<() => void> | null = null;
  try {
    await pass({});
    // a has taken more than b: it started first. d has not started yet.
    assert.equal(
      await pass({ "lab-kit-a": 130, "lab-kit-b": 103 }),
      "a copy of lab-kit-a",
    );
    assert.equal(
      holds.get("lab-kit-b"),
      "Queued: 1st in line: server-3 is busy with a copy of lab-kit-a",
    );
    // A backup from server-3 asks before d's copy starts.
    backup = takeTurn(["srv_3", "srv_2"], "a backup of lab-kit-c", {
      signal: stop.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    // The next pass comes at once, and a paced copy took 4 MB since: still a's turn.
    assert.equal(
      await pass({ "lab-kit-a": 134, "lab-kit-d": 86 }),
      "a copy of lab-kit-a",
    );
    assert.equal(holds.has("lab-kit-a"), false, "a's copy is never queued");
    assert.equal(
      holds.get("lab-kit-d"),
      "Queued: 3rd in line: server-3 is busy with a copy of lab-kit-a",
    );
    assert.equal(await pass({ "lab-kit-a": 146 }), "a copy of lab-kit-a");
    // a is whole: b, which asked next, goes; then the backup; then d.
    assert.equal(await pass({ "lab-kit-a": 146 }), "a copy of lab-kit-b");
    assert.equal(await pass({ "lab-kit-b": 146 }), "a copy of lab-kit-b");
    assert.equal(await pass({ "lab-kit-b": 146 }), null);
    const release = await backup;
    assert.equal(busyWith("srv_3"), "a backup of lab-kit-c");
    assert.equal(await pass({}), "a backup of lab-kit-c");
    assert.match(
      holds.get("lab-kit-d") ?? "",
      /busy with a backup of lab-kit-c$/,
    );
    release();
    assert.equal(await pass({}), "a copy of lab-kit-d");
  } finally {
    stop.abort();
    if (backup) (await backup)();
    turnWait.pollMs = poll;
    __forgetTurns();
  }
});
