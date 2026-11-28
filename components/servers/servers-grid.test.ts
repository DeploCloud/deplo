import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import type * as React from "react";

import { ServerHealthProvider } from "@/app/(dashboard)/[team]/settings/servers/server-health-provider";
import type { ServerCardData } from "@/app/(dashboard)/[team]/settings/servers/server-card";
import {
  ServersGrid,
  listedServers,
} from "@/app/(dashboard)/[team]/settings/servers/servers-grid";
import { ClusterView } from "@/app/(dashboard)/[team]/settings/servers/cluster-view";
import type { ClusterMember } from "@/lib/types/cluster";
import {
  clusterHealth,
  clusterSummary,
  type ClusterCardData,
} from "./cluster-card";
import { memberState } from "./cluster-join";
import { renderServerView } from "./server-test-helpers";

const member = (over: Partial<ClusterMember> = {}): ClusterMember => ({
  serverId: "srv_b",
  serverName: "server-b",
  status: "online",
  joinedAt: "2026-01-01T00:00:00.000Z",
  emptyingSince: null,
  emptying: null,
  held: 0,
  leaseState: "ok",
  provisioning: false,
  network: { relayed: [], unreachable: [] },
  relayWarning: "",
  nextInLine: 0,
  copyWarning: "",
  ...over,
});

const server = (
  id: string,
  over: Partial<ServerCardData> = {},
): ServerCardData => ({
  id,
  name: id,
  ip: "203.0.113.10",
  usage: null,
  apps: 0,
  joining: null,
  search: id,
  use: "everything",
  teams: [],
  isDeploHost: false,
  accessLabel: "All teams",
  agentVersion: "0.5.3",
  expected: "0.5.3",
  reach: "usable",
  health: {
    status: "online",
    checkedAt: null,
    message: null,
    traefikEnabled: true,
    lastReachedAt: null,
  },
  advice: "",
  uninstallPending: false,
  uninstallError: null,
  cluster: null,
  member: null,
  leader: false,
  ...over,
});

const eu = { id: "clu_eu", name: "eu", servers: 2 };
const FREE = server("server-a");
const JOINING = server("server-b", {
  cluster: eu,
  member: memberState(member({ provisioning: true })),
});
const SETTLED = server("server-c", {
  cluster: eu,
  member: memberState(member({ serverId: "srv_c" })),
  leader: true,
});

const CLUSTER: ClusterCardData = {
  id: "clu_eu",
  name: "eu",
  allTeams: true,
  teamIds: [],
  servers: 2,
  failoverEnabled: true,
  replicationEnabled: false,
  provisioning: 1,
  members: [
    { name: "server-b", online: false },
    { name: "server-c", online: true },
  ],
  totals: {
    cpu: 0,
    cores: 0,
    memUsed: 0,
    memTotal: 0,
    diskUsed: 0,
    diskTotal: 0,
  },
  apps: 0,
  joinOptions: [
    {
      serverId: "server-a",
      serverName: "server-a",
      blocked: "",
      apps: 2,
      databases: 1,
    },
  ],
};

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const withHealth = (child: React.ReactNode) =>
  text(
    renderServerView(
      createElement(
        // Its children arrive as the third argument, which the props type cannot see.
        ServerHealthProvider as unknown as React.FC<{ seed: object }>,
        { seed: {} },
        child,
      ),
    ),
  );

const grid = (props: {
  servers: ServerCardData[];
  clusters: ClusterCardData[];
}) =>
  withHealth(createElement(ServersGrid, { ...props, teams: [], view: "grid" }));

const inside = (servers: ServerCardData[]) =>
  withHealth(
    createElement(ClusterView, {
      cluster: {
        id: "clu_eu",
        name: "eu",
        allTeams: true,
        teamIds: [],
        failoverEnabled: true,
        replicationEnabled: false,
        loadBalancingEnabled: false,
        loadBalancingMode: "nearest",
        members: CLUSTER.members,
        totals: CLUSTER.totals,
        apps: 0,
      },
      servers,
      teams: [],
      joinOptions: [],
      leaderChoices: [],
    }),
  );

test("the top level shows each cluster as one card and only the servers outside a cluster", () => {
  const html = grid({
    servers: [FREE, JOINING, SETTLED],
    clusters: [CLUSTER],
  });
  assert.match(
    html,
    /eu Cluster · 1 provisioning 1\/2 2 servers - cores - memory 0 apps 1 of 2 servers online/,
  );
  const read = grid({
    servers: [],
    clusters: [
      {
        ...CLUSTER,
        totals: { ...CLUSTER.totals, cores: 8, memTotal: 16 * 2 ** 30 },
      },
    ],
  });
  assert.match(read, /8 cores 16 GiB memory/);
  assert.doesNotMatch(html, /Failover on/);
  assert.match(html, /server-a/);
  assert.doesNotMatch(html, /server-b|server-c/);
});

test("inside a cluster a server that just joined reads Provisioning until it works", () => {
  const html = inside([JOINING, SETTLED]);
  assert.match(html, /Servers eu .*2 servers acting as one/);
  assert.equal(html.match(/Provisioning/g)?.length, 1);
  assert.match(html, /server-b/);
  assert.match(html, /server-c/);
});

test("the cluster names the server its leader runs on", () => {
  const html = inside([JOINING, SETTLED]);
  assert.match(html, /acting as one · leader on server-c/);
  assert.match(html, /Leader on server-c/);
  assert.doesNotMatch(html, /leader on server-b/i);
});

test("a server's card leaves out its hardware and a lease the leader lost", () => {
  const fenced = server("server-d", {
    cluster: eu,
    member: memberState(member({ leaseState: "fenced" })),
  });
  const html = inside([fenced]);
  assert.doesNotMatch(html, /Not responding|GB RAM|run twice/);
});

test("a search lists the servers of every cluster together", () => {
  const all = [FREE, JOINING, SETTLED];
  assert.deepEqual(
    listedServers(all, false).map((s) => s.id),
    ["server-a"],
  );
  assert.equal(listedServers(all, true).length, 3);
});

test("a cluster card names what it is, and how many servers are still joining", () => {
  assert.equal(clusterSummary({ provisioning: 0 }), "Cluster");
  assert.equal(clusterSummary({ provisioning: 1 }), "Cluster · 1 provisioning");
});

test("a cluster's health chip stays short and says it in full in its tooltip", () => {
  assert.deepEqual(clusterHealth([]), {
    label: "Empty",
    full: "No servers yet",
    variant: "muted",
  });
  assert.deepEqual(clusterHealth([true, true]), {
    label: "2/2",
    full: "2 of 2 servers online",
    variant: "success",
  });
  assert.deepEqual(clusterHealth([true, false, true]), {
    label: "2/3",
    full: "2 of 3 servers online",
    variant: "warning",
  });
  assert.deepEqual(clusterHealth([false]), {
    label: "0/1",
    full: "0 of 1 server online",
    variant: "destructive",
  });
});

test("a server being removed says how far it has got, and why it stopped", () => {
  const moving = memberState(
    member({
      held: 3,
      emptying: {
        since: "2026-01-01T00:00:00.000Z",
        total: 5,
        left: 3,
        moving: "web",
        error: "",
      },
    }),
  );
  assert.equal(moving.emptying, "removing");
  assert.equal(moving.progress, "2 of 5 moved, moving web");
  const stopped = memberState(
    member({
      emptying: {
        since: "2026-01-01T00:00:00.000Z",
        total: 2,
        left: 2,
        moving: "",
        error: "No other server has room for web.",
      },
    }),
  );
  assert.equal(stopped.emptying, "stopped");
  assert.equal(stopped.error, "No other server has room for web.");
  assert.equal(memberState(member()).emptying, "idle");
});

test("a server of a cluster names the servers its private network does not reach directly, and nothing when all do", () => {
  const relayed = server("server-d", {
    cluster: eu,
    member: memberState(
      member({ network: { relayed: ["server-c"], unreachable: [] } }),
    ),
  });
  const down = server("server-e", {
    cluster: eu,
    member: memberState(
      member({ network: { relayed: [], unreachable: ["server-c"] } }),
    ),
  });
  const html = inside([SETTLED, relayed, down]);
  assert.match(html, /Reaches server-c through Deplo(&#x27;|')s relay/);
  assert.match(html, /Cannot reach server-c now/);
  assert.equal(memberState(member()).network, "");
  assert.equal(
    memberState(member({ network: { relayed: ["b", "a"], unreachable: [] } }))
      .network,
    "Reaches a and b through Deplo's relay, with more delay",
  );
  assert.equal(
    memberState(member({ network: { relayed: ["a"], unreachable: ["c"] } }))
      .network,
    "Cannot reach c now. Reaches a through Deplo's relay, with more delay",
  );
});

test("a server with no reading keeps the same three bars, empty, so every card has one height", () => {
  const html = grid({ servers: [FREE], clusters: [] });
  assert.match(html, /CPU - Memory - Disk -/);
});

test("a problem badge comes before the rest, so it is never the one folded into +N", () => {
  const old = server("server-a", { agentVersion: "0.5.2", expected: "0.5.3" });
  const html = grid({ servers: [old], clusters: [] });
  assert.ok(
    html.indexOf("agent v0.5.2") < html.indexOf("All teams"),
    "the outdated agent leads the row",
  );
});

test("the line under the badges shows the worst note, else when the server was last checked", () => {
  const quiet = grid({ servers: [FREE], clusters: [] });
  assert.match(quiet, /Not checked yet/);
  const waiting = server("server-a", {
    uninstallPending: true,
    uninstallError: "the server did not answer",
  });
  const html = grid({ servers: [waiting], clusters: [] });
  assert.match(
    html,
    /Deplo could not remove its agent: the server did not answer/,
  );
});
