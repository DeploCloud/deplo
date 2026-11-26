import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { TraefikConfigResponse } from "../agent/gen/agent";
import {
  clusterDnsZones,
  clusterJoinRequests,
  clusterMembers,
} from "../db/schema/control-plane/clusters";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { hasAnswerSupport, hasDnsChallenge } from "../deploy/traefik-cluster";
import {
  CLUSTER_ANSWERS_CAPABILITY,
  DNS_CHALLENGE_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import {
  admitLink,
  doorClosed,
  doorOpened,
  linkGeneration,
  nextLinkId,
} from "../infra/agent-link/registry";
import { INSTALLED_WITH_PANEL } from "../deploy/traefik-stack-test-helpers";
import { moveAppToCluster } from "./apps/source";
import { joinOnLink } from "./clusters/join-requests";
import { factsWait, joinWait } from "./clusters/member-choice";
import { addClusterMember } from "./clusters/members";
import { TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  activity,
  appRow,
  asAdmin,
  db,
  emptyLab,
  eu,
  hosts,
  runningApp,
} from "./cluster-empty-test-helpers";

// c48: eu-5's proxy answered 404 for the first App moved onto it until Deplo recreated it, 2 minutes after the join.
emptyLab();

const isMember = async (serverId: string) =>
  (
    await db
      .select({ id: clusterMembers.serverId })
      .from(clusterMembers)
      .where(eq(clusterMembers.serverId, serverId))
  ).length > 0;

/** Cluster eu whose zone answers and whose App web answers on every server; srv_4 is not in it yet. */
async function answeringEu() {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await db.insert(clusterDnsZones).values({
    id: "zone_1",
    clusterId: cluster.id,
    name: "go.example.com",
    createdAt: "2026-11-26T00:00:00.000Z",
  });
  await db.insert(domainsTable).values({
    id: "dom_web",
    appId: "web",
    name: "web.example.com",
    status: "valid",
    isPrimary: true,
    ssl: true,
    certProvider: "letsencrypt",
    answersEverywhere: true,
    createdAt: "2026-11-26T00:00:00.000Z",
  });
  const h = hosts.get("srv_4")!;
  h.capabilities.push(CLUSTER_ANSWERS_CAPABILITY, DNS_CHALLENGE_CAPABILITY);
  h.proxy.yaml = INSTALLED_WITH_PANEL;
  return { cluster, h };
}

test("a joining server's proxy takes the cluster's answers and DNS resolver in one restart, before it is a member", async () => {
  const { cluster, h } = await answeringEu();
  const memberAtRestart: boolean[] = [];
  h.extra.traefikConfig = async (req) => {
    memberAtRestart.push(await isMember("srv_4"));
    h.proxy.yaml = req.composeYaml;
    return TraefikConfigResponse.fromPartial({ ok: true });
  };
  await asAdmin(() => addClusterMember(cluster.id, "srv_4"));
  assert.deepEqual(memberAtRestart, [false], "one restart, before the join");
  assert.ok(hasAnswerSupport(h.proxy.yaml), "it passes cluster domains on");
  assert.ok(hasDnsChallenge(h.proxy.yaml), "it has the DNS resolver");
  assert.ok(await isMember("srv_4"));
});

// c49: through eu-4, visitors met 404 and a self-signed certificate for 105 s, until the 2-minute answers pass.
test("a new member is handed the cluster's routes as it joins, not at the next answers pass", async () => {
  const { cluster, h } = await answeringEu();
  h.extra.traefikConfig = async (req) => {
    h.proxy.yaml = req.composeYaml;
    return TraefikConfigResponse.fromPartial({ ok: true });
  };
  await asAdmin(() => addClusterMember(cluster.id, "srv_4"));
  const table = h.forwarders.at(-1);
  assert.ok(table, "its agent got a table");
  assert.deepEqual(table.serveAnswers, ["web"], "it answers for web");
  assert.ok(table.members.some((m) => m.serverId === "srv_4"));
});

test("a proxy that refuses the change keeps the server out of the cluster, saying why", async () => {
  const { cluster, h } = await answeringEu();
  h.proxy.refuse = "the disk is full";
  await assert.rejects(
    asAdmin(() => addClusterMember(cluster.id, "srv_4")),
    {
      message:
        "The proxy on srv_4 refused what cluster eu needs, so it did not join: the disk is full",
    },
  );
  assert.equal(await isMember("srv_4"), false);
});

test("a server waiting to join joins as soon as its agent links, before it reads online", async () => {
  const cluster = await eu();
  await db
    .update(serversTable)
    .set({ status: "pending" })
    .where(eq(serversTable.id, "srv_4"));
  await db.insert(clusterJoinRequests).values({
    serverId: "srv_4",
    clusterId: cluster.id,
    requestedByUserId: USER_1,
    requestedByTeamId: TEAM_A,
    requestedAt: new Date().toISOString(),
  });
  const off = joinOnLink(() => true);
  doorOpened();
  try {
    admitLink(
      {
        id: nextLinkId(),
        serverId: "srv_4",
        pinnedFingerprint: "4".repeat(64),
        client: {} as never,
        hello: {} as never,
        openedAt: Date.now(),
        heardAt: () => Date.now(),
        close() {},
      },
      linkGeneration("srv_4"),
    );
    for (let i = 0; i < 200 && !(await isMember("srv_4")); i++)
      await new Promise((r) => setTimeout(r, 10));
  } finally {
    off();
    doorClosed();
  }
  assert.ok(await isMember("srv_4"), "it joined at its link");
  assert.equal((await db.select().from(clusterJoinRequests)).length, 0);
});

test("a move towards a server still joining waits for it, says so, and goes once it joined", async () => {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await db.insert(clusterJoinRequests).values({
    serverId: "srv_4",
    clusterId: cluster.id,
    requestedByUserId: USER_1,
    requestedByTeamId: TEAM_A,
    requestedAt: new Date().toISOString(),
  });
  Object.assign(factsWait, { everyMs: 5 });
  joinWait.maxMs = 5_000;
  try {
    const moved = asAdmin(() => moveAppToCluster("web", cluster.id, "srv_4"));
    const said = "Deplo: Moving web waits for srv_4 to join cluster eu.";
    for (let i = 0; i < 200 && !(await activity()).includes(said); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok((await activity()).includes(said), "it says why it waits");
    assert.equal((await appRow("web")).serverId, "srv_2");
    await asAdmin(() => addClusterMember(cluster.id, "srv_4"));
    await moved;
  } finally {
    Object.assign(factsWait, { everyMs: 1_000 });
    joinWait.maxMs = 120_000;
  }
  assert.equal((await appRow("web")).serverId, "srv_4");
});

test("a move towards a server that does not join in time is refused with why, and nothing moves", async () => {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await db.insert(clusterJoinRequests).values({
    serverId: "srv_4",
    clusterId: cluster.id,
    requestedByUserId: USER_1,
    requestedByTeamId: TEAM_A,
    requestedAt: new Date().toISOString(),
    error: "The server agent on srv_4 is too old to join a cluster.",
  });
  Object.assign(factsWait, { everyMs: 5 });
  joinWait.maxMs = 30;
  try {
    await assert.rejects(
      asAdmin(() => moveAppToCluster("web", cluster.id, "srv_4")),
      {
        message:
          "srv_4 has not joined cluster eu within 0 s, so web stays where it runs. The server agent on srv_4 is too old to join a cluster.",
      },
    );
  } finally {
    Object.assign(factsWait, { everyMs: 1_000 });
    joinWait.maxMs = 120_000;
  }
  assert.equal((await appRow("web")).serverId, "srv_2");
  // c49: Activity kept only "waits", the refusal went to the API alone.
  assert.ok(
    (await activity()).includes(
      "Deplo: Moving web did not start: srv_4 has not joined cluster eu within 0 s, so web stays where it runs. The server agent on srv_4 is too old to join a cluster.",
    ),
  );
});
