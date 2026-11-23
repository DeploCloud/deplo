import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { activities } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import type { FakeClusterHost } from "../infra/agent-client/cluster-test-helpers";
import {
  listAppSetAsideCopies,
  removeAppSetAsideCopy,
  SET_ASIDE_CAPABILITY,
} from "./apps/set-aside";
import { deleteApp } from "./apps/delete";
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
  assert.deepEqual(asked, [[`deplo-${app.slug}_data`]]);
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
