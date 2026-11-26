import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { activities } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import type { FakeClusterHost } from "../infra/agent-client/cluster-test-helpers";
import {
  clearMetricsHistory,
  recordMetricsSample,
} from "../monitoring/history";
import type { ServerMetrics } from "../types/server";
import {
  expireSetAsideCopies,
  listAppSetAsideCopies,
  removeAppSetAsideCopy,
  SET_ASIDE_CAPABILITY,
} from "./apps/set-aside";
import { deleteApp } from "./apps/delete";
import { executeBackup } from "./backups/execute-backup";
import { seedDestination } from "./backup-test-helpers";
import { TEAM_A } from "./identity-test-helpers";
import { leaderLab } from "./cluster-leader-test-helpers";

const lab = leaderLab();
const { asAdmin, asTeamB, eu, clusterApp } = lab;

let hosts: Record<string, FakeClusterHost>;
beforeEach(() => {
  ({ hosts } = lab);
});

/** srv_3 holds one dated copy of the App's volume; srv_2's agent is too old to say. */
async function withCopy() {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await lab.db
    .update(appsTable)
    .set({
      compose:
        "services:\n  web:\n    image: nginx:1.27\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n",
    })
    .where(eq(appsTable.id, app.id));
  const asked: string[][] = [];
  const removed: string[] = [];
  hosts.srv_3.capabilities.push(SET_ASIDE_CAPABILITY);
  hosts.srv_3.extra = {
    setAsideCopies: async (of: string[]) => {
      asked.push(of);
      return [
        {
          volumeName: `deplo-${app.slug}_data-aside-20261123T040506Z`,
          of: `deplo-${app.slug}_data`,
          atMs: Date.parse("2026-11-23T04:05:06Z"),
          bytes: 4096,
        },
      ];
    },
    removeSetAside: async (name: string) => {
      removed.push(name);
      return { ok: true, error: "" };
    },
  };
  return { app, asked, removed };
}

test("the App's page lists the copies its cluster servers set aside, with date and size", async () => {
  const { app, asked } = await withCopy();
  const copies = await asAdmin(() => listAppSetAsideCopies(app.id));
  assert.deepEqual(asked, [
    [`deplo-${app.slug}_data`, `deplo-${app.slug}.files`],
  ]);
  assert.deepEqual(copies, [
    {
      serverId: "srv_3",
      serverName: "srv_3",
      volumeName: `deplo-${app.slug}_data-aside-20261123T040506Z`,
      of: `deplo-${app.slug}_data`,
      at: "2026-11-23T04:05:06.000Z",
      bytes: 4096,
    },
  ]);
  await assert.rejects(
    asTeamB(() => listAppSetAsideCopies(app.id)),
    /not found/i,
  );
});

test("a copy of the App's Files folder is listed as its Files", async () => {
  const { app } = await withCopy();
  hosts.srv_3.extra!.setAsideCopies = async () => [
    {
      volumeName: `deplo-${app.slug}.files-aside-20261123T040506Z`,
      of: `deplo-${app.slug}.files`,
      atMs: Date.parse("2026-11-23T04:05:06Z"),
      bytes: 12,
    },
  ];
  const [copy] = await asAdmin(() => listAppSetAsideCopies(app.id));
  assert.equal(copy?.of, "Files");
  assert.equal(
    copy?.volumeName,
    `deplo-${app.slug}.files-aside-20261123T040506Z`,
  );
});

test("one copy is removed from there, by name, and Activity says so; another name is refused", async () => {
  const { app, removed } = await withCopy();
  await assert.rejects(
    asAdmin(() =>
      removeAppSetAsideCopy(
        app.id,
        "srv_3",
        "deplo-other_data-aside-20261123T040506Z",
      ),
    ),
    /not one of this App's set-aside copies/,
  );
  assert.deepEqual(removed, []);
  await asAdmin(() =>
    removeAppSetAsideCopy(
      app.id,
      "srv_3",
      `deplo-${app.slug}_data-aside-20261123T040506Z`,
    ),
  );
  assert.deepEqual(removed, [`deplo-${app.slug}_data-aside-20261123T040506Z`]);
  const said = (await lab.db.select().from(activities)).map((a) => a.message);
  assert.ok(
    said.some((m) =>
      /Removed the copy of web's data that srv_3 set aside on 2026-11-23 04:05 UTC \(4 KiB\)/.test(
        m,
      ),
    ),
    said.join("\n"),
  );
});

test("deleting the App removes its set-aside copies on every server, and Activity says how many and where", async () => {
  const { app, removed } = await withCopy();
  await asAdmin(() => deleteApp(app.id));
  assert.deepEqual(removed, [`deplo-${app.slug}_data-aside-20261123T040506Z`]);
  const said = (await lab.db.select().from(activities)).map((a) => a.message);
  assert.ok(
    said.includes("Removed 1 set-aside copy of web's data: 1 on srv_3."),
    said.join("\n"),
  );
});

// c44: eu-1 kept 8 set-aside copies of fise, nearly 90% of its disk.
test("older set-aside copies go after 7 days, or after 1 once the server is past 80% full; the newest stays", async () => {
  const { app, removed } = await withCopy();
  const at = [
    "2026-11-25T10:00:00Z",
    "2026-11-24T00:00:00Z",
    "2026-11-10T00:00:00Z",
  ];
  const name = (t: string) =>
    `deplo-${app.slug}_data-aside-${t.replace(/[-:]/g, "")}`;
  hosts.srv_3.extra!.setAsideCopies = async () =>
    at
      .filter((t) => !removed.includes(name(t)))
      .map((t) => ({
        volumeName: name(t),
        of: `deplo-${app.slug}_data`,
        atMs: Date.parse(t),
        bytes: 4096,
      }));
  const now = Date.parse("2026-11-26T12:00:00Z");

  await expireSetAsideCopies(app.id, now);
  assert.deepEqual(removed, [name(at[2]!)]);

  recordMetricsSample({
    serverId: "srv_3",
    online: true,
    diskUsed: 13e9,
    diskTotal: 14e9,
    diskPct: 0,
    ts: Date.now(),
  } as ServerMetrics);
  try {
    await expireSetAsideCopies(app.id, now);
  } finally {
    clearMetricsHistory();
  }
  assert.deepEqual(removed, [name(at[2]!), name(at[1]!)]);
  const said = (await lab.db.select().from(activities)).map((a) => a.message);
  for (const line of [
    "Removed the copy of web's data that srv_3 set aside on 2026-11-10 00:00 UTC (4 KiB): it was older than 7 days, and a newer copy is kept.",
    "Removed the copy of web's data that srv_3 set aside on 2026-11-24 00:00 UTC (4 KiB): srv_3 is more than 80% full, and a newer copy is kept.",
  ])
    assert.ok(said.includes(line), said.join("\n"));
});

test("a backup of the App clears what its servers set aside of it long ago", async () => {
  const { app, removed } = await withCopy();
  const old = `deplo-${app.slug}_data-aside-20261001T000000Z`;
  const listed = hosts.srv_3.extra!.setAsideCopies!;
  hosts.srv_3.extra!.setAsideCopies = async (of: string[]) => [
    ...(await listed(of)),
    ...(removed.includes(old)
      ? []
      : [
          {
            volumeName: old,
            of: `deplo-${app.slug}_data`,
            atMs: Date.parse("2026-10-01T00:00:00Z"),
            bytes: 4096,
          },
        ]),
  ];
  await seedDestination(lab.db, { id: "dst_s3" });
  const runsOn = hosts[app.serverId]!;
  runsOn.capabilities.push("backup", "backup-store", "backup-encrypt-s3");
  runsOn.extra = {
    ...runsOn.extra,
    backup: async function* () {
      yield {
        result: {
          ok: true,
          error: "",
          objectKey: "",
          sizeBytes: 2048,
          sha256: "ab12",
        },
      };
    },
  } as typeof runsOn.extra;

  await executeBackup(TEAM_A, "Deplo", {
    backupId: null,
    kind: "app",
    databaseId: null,
    appId: app.id,
    destinationId: "dst_s3",
    retentionCount: 7,
  });

  assert.deepEqual(removed, [old]);
});
