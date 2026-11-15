import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "yaml";

import { seedDeployment } from "./app-graph-test-helpers";
import { pushAppBundle } from "./clusters/app-restore";
import { type FailoverStack, flushFailoverBundles } from "./clusters/bundles";
import { deleteEnv, listEnv, upsertEnv } from "./env";
import {
  asAdmin,
  databaseLab,
  db,
  eu,
  leader,
  open,
  web,
} from "./cluster-database-test-helpers";

databaseLab();

const STACK: FailoverStack = {
  slug: "web",
  projectId: "prj_web",
  imageRef: "deplo/web:dpl_1",
  composeYaml:
    'services:\n  web:\n    image: deplo/web:dpl_1\n    environment:\n      PORT: "3000"\n',
  network: "deplo-team-team_a",
  env: {},
  registryAuth: [],
  composeUpArgs: [],
};

const envInBundle = async () => {
  await flushFailoverBundles();
  const b = await open("app/prj_web");
  return (
    parse(b.stack.composeYaml) as {
      services: { web: { environment?: Record<string, string> } };
    }
  ).services.web.environment;
};

test("a variable saved on a cluster App reaches its failover copy at once, not at the next deploy", async () => {
  const cluster = await eu();
  await web(cluster.id, "srv_2");
  await seedDeployment(db, { id: "dpl_1", appId: "prj_web", status: "ready" });
  await pushAppBundle({
    appId: "prj_web",
    deploymentId: "dpl_1",
    stack: STACK,
  });
  assert.deepEqual(await envInBundle(), { PORT: "3000" });

  await asAdmin(() =>
    upsertEnv({
      appId: "prj_web",
      key: "API_URL",
      value: "https://a.example",
      type: "plain",
    }),
  );
  assert.deepEqual(await envInBundle(), {
    PORT: "3000",
    API_URL: "https://a.example",
  });

  const [row] = await asAdmin(() => listEnv("prj_web"));
  await asAdmin(() => deleteEnv(row.id));
  assert.deepEqual(await envInBundle(), { PORT: "3000" });
});

test("a variable of an App on one server touches no failover copy", async () => {
  await asAdmin(async () => {
    const { seedApp } = await import("./app-graph-test-helpers");
    await seedApp(db, { id: "prj_solo", slug: "solo", serverId: "srv_2" });
    await upsertEnv({ appId: "prj_solo", key: "A", value: "1", type: "plain" });
  });
  await flushFailoverBundles();
  assert.equal(leader.held.size, 0);
});
