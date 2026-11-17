import { test } from "node:test";
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
  dissolveHarness,
  hosts,
} from "./cluster-dissolve-test-helpers";

dissolveHarness();

type Svc = Record<string, unknown> & { labels?: string[] };
const services = (doc: string) =>
  (yaml.load(doc) as { services: Record<string, Svc> }).services;

const supervising = (...ids: string[]) => {
  for (const id of ids)
    hosts[id].capabilities.push(CLUSTER_SUPERVISE_CAPABILITY);
};

test("a cluster supervises its writers only when every member's agent says so", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  assert.equal(
    await asAdmin(() => clusterSupervisesWriters(cluster.id)),
    false,
    "no agent says so yet",
  );
  supervising(MEMBERS[0], MEMBERS[1]);
  assert.equal(
    await asAdmin(() => clusterSupervisesWriters(cluster.id)),
    false,
    "a failover may start it on the third",
  );
  supervising(MEMBERS[2]);
  assert.equal(await asAdmin(() => clusterSupervisesWriters(cluster.id)), true);
  hosts[MEMBERS[2]].unreachable = true;
  assert.equal(
    await asAdmin(() => clusterSupervisesWriters(cluster.id)),
    false,
    "a member that cannot answer keeps Docker's policy",
  );
  assert.equal(
    await asAdmin(() => clusterSupervisesWriters("clu_none")),
    false,
    "a cluster without members",
  );
});

test("only what keeps data on such a cluster starts under its lease", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  supervising(...MEMBERS);
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
