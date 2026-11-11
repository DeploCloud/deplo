import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { runWithIdentity } from "../auth/request-context";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  clusterTeams,
  clusters as clustersTable,
  imageArchitectures as archsTable,
} from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { fakeRegistry } from "../registry/registry-test-helpers";
import { loadAppGraph } from "./app-graph-load";
import { seedApp } from "./app-graph-test-helpers";
import { createApp } from "./apps/create";
import { moveAppToCluster } from "./apps/source";
import { seedDatabase } from "./backup-test-helpers";
import {
  apply,
  asAdmin,
  databaseLab,
  db,
  deploSaid,
  eu,
  event,
  leaderHost,
  main,
  web,
} from "./cluster-database-test-helpers";
import {
  appFailoverReach,
  databaseFailoverReach,
  imageArchs,
} from "./clusters/architectures";
import { flushFailoverBundles, pushFailoverBundle } from "./clusters/bundles";
import { pushDatabaseBundle } from "./clusters/database-bundles";
import { setClusterTeams } from "./clusters/manage";
import { createDatabase } from "./databases/provision";
import { moveDatabaseToCluster } from "./databases/server-move";
import { TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { saveNotificationChannel } from "./notifications";
import { __resetCooldowns } from "../notify/cooldown";
import { __settleAlertsForTest } from "../notify/dispatch";
import { captureFetch } from "../notify/fetch-capture-test-helpers";
import { runTool } from "../mcp/run-tool-test-helpers";
import { getDatabase } from "./databases/rows";

databaseLab();

const dec = new TextDecoder();
const enc = new TextEncoder();
const WEB = "1.1.1.1/acme/web:1";
const BOTH = ["amd64", "arm64"];
// A server outside the cluster, for what moves onto it.
const SERVER_OUT = "srv_out";

type Asked = { workload: { name: string; archs: string[] } };
/** What the leader was asked to place, in order, and what it answers: a member, or a refusal. */
let asked: Asked[] = [];
let refusal: string | null = null;

beforeEach(async () => {
  await db.delete(archsTable);
  await seedServerRow(db, {
    id: SERVER_OUT,
    name: "server-out",
    ip: "10.0.0.9",
    host: "10.0.0.9",
  });
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: "9".repeat(64), hostArch: "amd64" })
    .where(eq(serversTable.id, SERVER_OUT));
  asked = [];
  refusal = null;
  const calls = leaderHost.leader;
  leaderHost.leader = (method, payload) => {
    if (method !== "placement.place") return calls(method, payload);
    const body = JSON.parse(dec.decode(payload)) as Asked;
    asked.push(body);
    return enc.encode(
      JSON.stringify(
        refusal
          ? { refusal: { reason: refusal, neededMb: 256, cluster: "c" } }
          : { member: "srv_2" },
      ),
    );
  };
});

const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

const arch = (id: string, hostArch: string) =>
  db.update(serversTable).set({ hostArch }).where(eq(serversTable.id, id));

/** Cluster "eu" of three servers: server-2 and server-3 are x86 unless said otherwise, server-4 is ARM. */
async function mixed(over: Record<string, string> = {}) {
  for (const [id, a] of Object.entries({ srv_4: "arm64", ...over }))
    await arch(id, a);
  return eu(["srv_2", "srv_3", "srv_4"]);
}

const pulls = (id: string, image: string) =>
  db
    .update(appsTable)
    .set({ source: "docker-image", dockerImage: image, repoUrl: null })
    .where(eq(appsTable.id, id));

const newApp = (clusterId: string) =>
  createApp({
    name: "web",
    source: "docker-image",
    repo: null,
    dockerImage: WEB,
    deploy: false,
    clusterId,
  });

/** The placement facts the leader last took with a bundle of this workload. */
function metaOf(kind: string, id: string): { archs: string[] } {
  const put = leaderHost.calls
    .filter((c) => c.method === "leader.bundle.put")
    .map((c) => JSON.parse(dec.decode(c.payload)))
    .findLast((b) => b.kind === kind && b.id === id);
  assert.ok(put, `no bundle of ${kind} ${id} reached the leader`);
  return put.meta;
}

const stack = (imageRef: string) => ({
  slug: "web",
  projectId: "prj_web",
  imageRef,
  composeYaml: "services: {}",
  network: "deplo-team-a",
  env: {},
  registryAuth: [],
  composeUpArgs: [],
});

test("a built image runs where it was built, and no registry is asked", async () => {
  await arch("srv_4", "arm64");
  const registry = fakeRegistry({});
  assert.deepEqual(await imageArchs("deplo/web:dpl_1", "srv_4"), ["arm64"]);
  assert.deepEqual(await imageArchs("deplo/web:dpl_1", "srv_2"), ["amd64"]);
  assert.deepEqual(registry, []);
});

test("a pulled image runs wherever its registry lists, which is read once and kept", async () => {
  const registry = fakeRegistry({ "acme/web:1": BOTH });
  assert.deepEqual(await imageArchs(WEB, "srv_2"), BOTH);
  // The registry goes away: what it said stands, and it is not asked again the same day.
  fakeRegistry({});
  assert.deepEqual(await imageArchs(WEB, "srv_2"), BOTH);
  assert.deepEqual(registry, ["acme/web:1"]);
});

test("an image no registry describes runs only on the kind of server it runs on now, never anywhere", async () => {
  await arch("srv_4", "arm64");
  const registry = fakeRegistry({});
  assert.deepEqual(await imageArchs(WEB, "srv_4"), ["arm64"]);
  assert.deepEqual(await imageArchs(WEB, "srv_2"), ["amd64"]);
  // Asked once: a registry that has nothing to say is left alone for a while.
  assert.deepEqual(registry, ["acme/web:1"]);
  // One that runs nowhere yet has no server to be kept on.
  assert.deepEqual(await imageArchs(WEB), []);
});

test("a new App from a pulled image is only offered servers its image runs on", async () => {
  const cluster = await mixed();
  fakeRegistry({ "acme/web:1": ["arm64"] });
  refusal = "no_room";

  await assert.rejects(
    () => asAdmin(() => newApp(cluster.id)),
    /^Error: No ARM server in cluster eu has 256 MB free\. Add an ARM server to it or lower web's memory\.$/,
  );
  assert.deepEqual(asked[0]!.workload.archs, ["arm64"]);

  refusal = "no_architecture";
  await assert.rejects(
    () => asAdmin(() => newApp(cluster.id)),
    /^Error: web runs on ARM servers only, and none in cluster eu can take it\. Add an ARM server\.$/,
  );
  assert.equal((await db.select().from(appsTable)).length, 0);
});

test("an image that runs on every server of the cluster is refused in the plain words", async () => {
  const cluster = await mixed();
  fakeRegistry({ "acme/web:1": BOTH });
  refusal = "no_room";
  await assert.rejects(
    () => asAdmin(() => newApp(cluster.id)),
    /^Error: No server in cluster eu has 256 MB free\. Add a server to it or lower web's memory\.$/,
  );
  assert.deepEqual(asked[0]!.workload.archs, BOTH);
});

test("a team the cluster is not shared with places nothing on it and its leader is never asked", async () => {
  const cluster = await mixed();
  await asAdmin(() =>
    setClusterTeams(cluster.id, { allTeams: false, teamIds: [TEAM_A] }),
  );
  fakeRegistry({ "acme/web:1": ["arm64"] });
  refusal = "no_room";
  await assert.rejects(
    () => asTeamB(() => newApp(cluster.id)),
    /That cluster isn't available to this team\./,
  );
  assert.equal(asked.length, 0);
});

test("moving an App onto a cluster: a pulled image keeps its architecture, a built one is built again anywhere", async () => {
  await arch("srv_4", "arm64");
  const cluster = await eu(["srv_2", "srv_3"]);
  await seedApp(db, { id: "prj_pulled", slug: "pulled", serverId: "srv_4" });
  await pulls("prj_pulled", WEB);
  await seedApp(db, { id: "prj_built", slug: "built", serverId: "srv_4" });
  fakeRegistry({});
  refusal = "no_architecture";

  await assert.rejects(
    () => asAdmin(() => moveAppToCluster("prj_pulled", cluster.id)),
    /prj_pulled runs on ARM servers only, and none in cluster eu can take it\. Add an ARM server\./,
  );
  await assert.rejects(() =>
    asAdmin(() => moveAppToCluster("prj_built", cluster.id)),
  );
  assert.deepEqual(
    asked.map((a) => a.workload.archs),
    [["arm64"], []],
  );
});

test("a database's official image is not kept on one kind of server", async () => {
  const cluster = await mixed();
  fakeRegistry({ "library/postgres:16-alpine": BOTH });
  refusal = "no_room";

  await assert.rejects(
    () =>
      asAdmin(() =>
        createDatabase({
          name: "main",
          type: "postgres",
          version: "16",
          clusterId: cluster.id,
        }),
      ),
    /No server in cluster eu has 256 MB free\./,
  );
  await seedDatabase(db, { id: "db_1", name: "other", serverId: SERVER_OUT });
  await assert.rejects(() =>
    asAdmin(() => moveDatabaseToCluster("db_1", cluster.id)),
  );
  assert.deepEqual(
    asked.map((a) => a.workload.archs),
    [BOTH, BOTH],
  );
});

test("a database whose image no registry describes moves only to the kind of server it runs on", async () => {
  const cluster = await mixed();
  fakeRegistry({});
  await seedDatabase(db, { id: "db_1", name: "other", serverId: SERVER_OUT });
  await db
    .update(databasesTable)
    .set({ customImage: "1.1.1.1/acme/pg:16" })
    .where(eq(databasesTable.id, "db_1"));
  refusal = "no_room";

  await assert.rejects(
    () => asAdmin(() => moveDatabaseToCluster("db_1", cluster.id)),
    /No x86 server in cluster eu has 256 MB free\. Add an x86 server to it or lower other's memory\./,
  );
  assert.deepEqual(asked[0]!.workload.archs, ["amd64"]);
});

test("the leader is told what each workload runs on, so a failover follows the same rule", async () => {
  const cluster = await mixed();
  await web(cluster.id, "srv_4");
  await main(cluster.id);
  fakeRegistry({
    "acme/web:1": BOTH,
    "library/postgres:16-alpine": BOTH,
  });
  const push = async (imageRef: string) => {
    await pushFailoverBundle({
      appId: "prj_web",
      deploymentId: `dpl_${imageRef.length}`,
      stack: stack(imageRef),
    });
    await flushFailoverBundles();
    return metaOf("app", "prj_web").archs;
  };

  // Built on the ARM server: ARM only. Pulled for both: either. Pulled from a registry that says nothing: where it runs.
  assert.deepEqual(await push("deplo/web:dpl_1"), ["arm64"]);
  assert.deepEqual(await push(WEB), BOTH);
  assert.deepEqual(await push("1.1.1.1/acme/private:1"), ["arm64"]);
  // A stack of several images names none: it stays on its own kind of server.
  assert.deepEqual(await push(""), ["arm64"]);

  await pushDatabaseBundle("db_main");
  assert.deepEqual(metaOf("database", "db_main").archs, BOTH);
});

test("an App left waiting on a mixed cluster is told which kind of server it waits for", async () => {
  const cluster = await mixed({ srv_3: "arm64" });
  await web(cluster.id, "srv_2");
  await main(cluster.id);
  // The official image was read at a deploy: the database can use every server, the built App only x86.
  fakeRegistry({ "library/postgres:16-alpine": BOTH });
  await imageArchs("postgres:16-alpine", "srv_2");
  await asAdmin(() =>
    saveNotificationChannel(null, {
      kind: "webhook",
      name: "",
      enabled: true,
      url: "https://ops/hook",
      target: "",
      emailFrom: "",
      emailProvider: "resend",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      alerts: ["cluster_failover_waiting"],
    }),
  );
  __resetCooldowns();
  const capture = captureFetch();

  try {
    await apply(
      cluster.id,
      event(cluster.id, "failover", {
        member: "srv_2",
        reason: "stopped_answering",
        moved: [],
        waiting: [
          { kind: "database", workloadId: "db_main", reason: "no_room" },
          { kind: "app", workloadId: "prj_web", reason: "no_architecture" },
        ],
      }),
    );
    await __settleAlertsForTest();
  } finally {
    capture.restore();
  }

  // The alert names the kind of server too, as Activity does.
  assert.deepEqual(
    capture.calls.map((c) => (c.body as { body?: string }).body),
    [
      "server-2 stopped answering. No other server has room for main yet. There is no other x86 server to take web. Deplo tries again every 30 seconds.",
    ],
  );

  assert.deepEqual(
    (await deploSaid()).filter((m) => /is waiting/.test(m)),
    [
      "main is waiting for room in eu: server-2 stopped answering and no other server has room yet",
      "web is waiting in eu: server-2 stopped answering and there is no other x86 server to take it",
    ],
  );
});

const reach = async () =>
  asAdmin(async () => appFailoverReach((await loadAppGraph("prj_web"))!));

test("App page: a cluster of one kind of server says nothing", async () => {
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await web(cluster.id, "srv_2");
  assert.deepEqual(await reach(), { line: null, warning: null });
});

test("App page: a mixed cluster with several servers of its kind says which and how many", async () => {
  const cluster = await mixed();
  await web(cluster.id, "srv_2");
  assert.deepEqual(await reach(), {
    line: "Fails over to x86 servers only (2 of 3)",
    warning: null,
  });
});

test("App page: a mixed cluster with one server of its kind warns that it has nowhere to go", async () => {
  const cluster = await mixed({ srv_3: "arm64" });
  await web(cluster.id, "srv_2");
  assert.deepEqual(await reach(), {
    line: null,
    warning:
      "If server-2 stops, web has nowhere to go. It is the only x86 server in eu.",
  });
});

test("App page: an image that runs on both kinds is not restricted, and reading it asks no registry", async () => {
  const cluster = await mixed();
  await web(cluster.id, "srv_2");
  await pulls("prj_web", WEB);
  const registry = fakeRegistry({ "acme/web:1": BOTH });

  // Nobody read the registry yet: it is kept where it runs.
  assert.equal((await reach()).line, "Fails over to x86 servers only (2 of 3)");
  assert.deepEqual(registry, []);

  // A deploy reads it; from then on the page knows.
  await imageArchs(WEB, "srv_2");
  assert.deepEqual(await reach(), { line: null, warning: null });
});

test("App page: a team the cluster was taken from is told nothing about its servers", async () => {
  const cluster = await mixed({ srv_3: "arm64" });
  await seedApp(db, {
    id: "prj_theirs",
    slug: "theirs",
    serverId: "srv_2",
    teamId: TEAM_B,
  });
  await db
    .update(appsTable)
    .set({ clusterId: cluster.id })
    .where(eq(appsTable.id, "prj_theirs"));
  const theirs = () =>
    asTeamB(async () => appFailoverReach((await loadAppGraph("prj_theirs"))!));

  assert.match((await theirs()).warning ?? "", /^If server-2 stops/);
  // Sharing no longer lets this happen; a cluster narrowed before that rule still reads as nothing.
  await db
    .update(clustersTable)
    .set({ allTeams: false })
    .where(eq(clustersTable.id, cluster.id));
  await db
    .insert(clusterTeams)
    .values({ clusterId: cluster.id, teamId: TEAM_A });
  assert.deepEqual(await theirs(), { line: null, warning: null });
});

const me = { userId: USER_1, teamId: TEAM_A };
const viaMcp = async (tool: string, args: Record<string, unknown>) => {
  const got = await runTool(me, tool, args);
  assert.equal(got.error, undefined, got.error ?? "");
  // As it goes over the wire: graphql's own objects have no prototype.
  return JSON.parse(JSON.stringify(got.data)) as Record<
    string,
    { failoverReach: unknown } | null
  >;
};

test("GraphQL and MCP read which servers an App can fail over to", async () => {
  const cluster = await mixed();
  await web(cluster.id, "srv_2");
  assert.deepEqual(
    (await viaMcp("get_app", { slug: "web" })).app!.failoverReach,
    { line: "Fails over to x86 servers only (2 of 3)", warning: null },
  );

  // An image for both kinds is not restricted: nothing to say.
  await pulls("prj_web", WEB);
  fakeRegistry({ "acme/web:1": BOTH });
  await imageArchs(WEB, "srv_2");
  assert.equal(
    (await viaMcp("get_app", { slug: "web" })).app!.failoverReach,
    null,
  );
});

const dbReach = () =>
  asAdmin(async () => databaseFailoverReach((await getDatabase("db_main"))!));

test("Database page: a mixed cluster says which servers the database can fail over to", async () => {
  const cluster = await mixed();
  await main(cluster.id);
  // Nobody read its image yet: it is kept on the kind of server it runs on.
  assert.deepEqual(await dbReach(), {
    line: "Fails over to x86 servers only (2 of 3)",
    warning: null,
  });
  assert.deepEqual(
    (await viaMcp("get_database", { id: "db_main" })).database!.failoverReach,
    { line: "Fails over to x86 servers only (2 of 3)", warning: null },
  );

  fakeRegistry({ "library/postgres:16-alpine": BOTH });
  await imageArchs("postgres:16-alpine", "srv_2");
  assert.deepEqual(await dbReach(), { line: null, warning: null });
});

test("Database page: the only server of its kind warns, and a database on one server says nothing", async () => {
  const cluster = await mixed({ srv_3: "arm64" });
  await main(cluster.id);
  assert.deepEqual(await dbReach(), {
    line: null,
    warning:
      "If server-2 stops, main has nowhere to go. It is the only x86 server in eu.",
  });

  await db
    .update(databasesTable)
    .set({ clusterId: null })
    .where(eq(databasesTable.id, "db_main"));
  assert.deepEqual(await dbReach(), { line: null, warning: null });
});
