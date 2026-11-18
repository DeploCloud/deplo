import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as yaml from "js-yaml";

import { CLUSTER_SUPERVISE_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { renderCompose } from "../deploy/build/compose-render";
import { buildComposeStack } from "../deploy/compose-stack/render";
import { generateDatabaseCompose } from "../deploy/database-compose";
import { RESTART_LABEL } from "../deploy/restart-under-lease";
import {
  appStartsUnderLease,
  clusterSupervisesWriters,
  databaseStartsUnderLease,
} from "./clusters/supervise";
import {
  MEMBERS,
  asAdmin,
  clusterOf,
  db,
  dissolveHarness,
  hosts,
} from "./cluster-dissolve-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { serverAgentCapabilities } from "../db/schema/control-plane/servers";
import {
  __forgetAgentHellos,
  recordAgentHello,
} from "./servers/agent-capabilities";

dissolveHarness();

type Svc = Record<string, unknown> & { labels?: string[] };
const services = (doc: string) =>
  (yaml.load(doc) as { services: Record<string, Svc> }).services;

const FAILSAFE = "0.5.3-canary.11";
// A Hello from each server, as the agent link's door or a connection hears it.
const hello = (id: string, version: string, caps: string[]) =>
  recordAgentHello(id, version, caps);
const supervising = (...ids: string[]) =>
  Promise.all(
    ids.map((id) =>
      hello(id, FAILSAFE, ["cluster", CLUSTER_SUPERVISE_CAPABILITY]),
    ),
  );

beforeEach(async () => {
  __forgetAgentHellos();
  await db().delete(serverAgentCapabilities);
});

test("a cluster supervises its writers only when every member's agent said so", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  assert.equal(
    await asAdmin(() => clusterSupervisesWriters(cluster.id)),
    false,
    "no agent has said anything yet",
  );
  for (const id of MEMBERS)
    await hello(id, "0.5.3-canary.10", ["cluster", "cluster.supervise"]);
  assert.equal(
    await asAdmin(() => clusterSupervisesWriters(cluster.id)),
    false,
    "agent 0.5.3-canary.10 says cluster.supervise and leaves a writer it cannot read down",
  );
  await supervising(MEMBERS[0], MEMBERS[1]);
  assert.equal(
    await asAdmin(() => clusterSupervisesWriters(cluster.id)),
    false,
    "a failover may start it on the third",
  );
  await supervising(MEMBERS[2]);
  assert.equal(await asAdmin(() => clusterSupervisesWriters(cluster.id)), true);
  assert.equal(
    await asAdmin(() => clusterSupervisesWriters("clu_none")),
    false,
    "a cluster without members",
  );
});

test("a render never dials a server: one that is down keeps what it last reported", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  await supervising(...MEMBERS);
  hosts[MEMBERS[2]].unreachable = true;
  const calls = MEMBERS.map((id) => hosts[id].calls.length);
  const started = Date.now();
  assert.equal(await asAdmin(() => clusterSupervisesWriters(cluster.id)), true);
  assert.ok(Date.now() - started < 1000, "waited on a server that is down");
  assert.deepEqual(
    MEMBERS.map((id) => hosts[id].calls.length),
    calls,
    "a render dialed a server",
  );
});

test("a downgraded agent loses the capability at its first Hello, and Activity says so", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  await supervising(...MEMBERS);
  assert.equal(await asAdmin(() => clusterSupervisesWriters(cluster.id)), true);
  await hello(MEMBERS[2], "0.5.3-canary.10", ["cluster", "cluster.supervise"]);
  assert.equal(
    await asAdmin(() => clusterSupervisesWriters(cluster.id)),
    false,
    "the first render after the reconnect renders Docker's policy",
  );
  const rows = await db()
    .select({ message: activities.message })
    .from(activities);
  assert.ok(
    rows.some(
      (r) =>
        r.message.includes(
          "went back from v0.5.3-canary.11 to v0.5.3-canary.10",
        ) && r.message.includes(CLUSTER_SUPERVISE_CAPABILITY),
    ),
    JSON.stringify(rows),
  );
  await hello(MEMBERS[2], FAILSAFE, ["cluster", CLUSTER_SUPERVISE_CAPABILITY]);
  assert.equal(await asAdmin(() => clusterSupervisesWriters(cluster.id)), true);
});

test("the same Hello twice writes nothing", async () => {
  await supervising(MEMBERS[0]);
  const first = await db()
    .select({ at: serverAgentCapabilities.reportedAt })
    .from(serverAgentCapabilities);
  await new Promise((r) => setTimeout(r, 5));
  __forgetAgentHellos();
  await supervising(MEMBERS[0]);
  const again = await db()
    .select({ at: serverAgentCapabilities.reportedAt })
    .from(serverAgentCapabilities);
  assert.deepEqual(again, first);
});

test("only what keeps data on such a cluster starts under its lease", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  await supervising(...MEMBERS);
  const volume = { type: "named" as const, name: "data", mountPath: "/data" };
  await asAdmin(async () => {
    assert.equal(
      await appStartsUnderLease({ clusterId: cluster.id, volumes: [volume] }),
      true,
    );
    assert.equal(
      await appStartsUnderLease({ clusterId: cluster.id, volumes: [] }),
      false,
      "nothing to keep",
    );
    assert.equal(
      await appStartsUnderLease({ clusterId: null, volumes: [volume] }),
      false,
      "on one server",
    );
    assert.equal(
      await appStartsUnderLease({
        clusterId: cluster.id,
        compose:
          "services:\n  a:\n    image: x\n    volumes: [d:/d]\nvolumes:\n  d: {}\n",
      }),
      true,
      "a stack's own volume",
    );
    assert.equal(
      await databaseStartsUnderLease({ clusterId: cluster.id }),
      true,
    );
    assert.equal(await databaseStartsUnderLease({ clusterId: null }), false);
  });
});

test("an App's stack renders restart policy no, and says what it stands for", () => {
  const render = (underLease: boolean) =>
    services(
      renderCompose({
        name: "deplo-notes",
        image: "memos:1",
        port: 5230,
        appId: "prj_1",
        network: "deplo-team-t",
        deployKey: "notes",
        routes: [],
        env: {},
        underLease,
      }),
    )["deplo-notes"];
  const svc = render(true);
  assert.equal(svc.restart, "no");
  assert.ok(
    svc.labels?.includes(`${RESTART_LABEL}=unless-stopped`),
    String(svc.labels),
  );
  const plain = render(false);
  assert.equal(plain.restart, "unless-stopped");
  assert.ok(!plain.labels?.some((l) => l.startsWith(RESTART_LABEL)));
});

test("a database renders restart policy no on such a cluster, its standby copy too", () => {
  const db = (
    underLease: boolean,
    standby?: { command: string[]; env: string[] },
  ) =>
    services(
      generateDatabaseCompose({
        name: "db-pg",
        databaseId: "db_1",
        type: "postgres",
        version: "17",
        username: "u",
        password: "p",
        dbName: "app",
        network: "deplo-team-t",
        underLease,
        standby,
      }),
    );
  const live = db(true)["db-pg"];
  assert.equal(live.restart, "no");
  assert.ok(live.labels?.includes(`${RESTART_LABEL}=unless-stopped`));
  const copy = Object.values(db(true, { command: ["postgres"], env: [] }))[0];
  assert.equal(copy.restart, "no");
  assert.equal(db(false)["db-pg"].restart, "unless-stopped");
});

test("a compose stack keeps each service's own policy in the label, and leaves one that never restarts alone", () => {
  const doc = services(
    buildComposeStack({
      network: "deplo-team-t",
      compose: `services:
  web:
    image: nginx
    restart: always
  worker:
    image: busybox
    restart: on-failure:3
  seed:
    image: busybox
    restart: "no"
  once:
    image: busybox
`,
      name: "deplo-shop",
      deployKey: "shop",
      appId: "prj_2",
      domainRoutes: [],
      underLease: true,
    }),
  );
  assert.equal(doc.web.restart, "no");
  assert.ok(doc.web.labels?.includes(`${RESTART_LABEL}=always`));
  assert.equal(doc.worker.restart, "no");
  assert.ok(doc.worker.labels?.includes(`${RESTART_LABEL}=on-failure`));
  for (const name of ["seed", "once"]) {
    assert.ok(
      !doc[name].labels?.some((l) => l.startsWith(RESTART_LABEL)),
      name,
    );
  }
  assert.equal(doc.once.restart, undefined);
});
