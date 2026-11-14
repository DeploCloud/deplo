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
import type { ClusterMember } from "@/lib/types/cluster";
import { clusterSummary, type ClusterCardData } from "./cluster-card";
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
  ...over,
});

const server = (
  id: string,
  over: Partial<ServerCardData> = {},
): ServerCardData => ({
  id,
  name: id,
  ip: "203.0.113.10",
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
  provisioning: 1,
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

const grid = (props: {
  servers: ServerCardData[];
  clusters: ClusterCardData[];
  openCluster: { id: string; name: string } | null;
}) =>
  text(
    renderServerView(
      createElement(
        // Its children arrive as the third argument, which the props type cannot see.
        ServerHealthProvider as unknown as React.FC<{ seed: object }>,
        { seed: {} },
        createElement(ServersGrid, { ...props, teams: [], view: "grid" }),
      ),
    ),
  );

test("the top level shows each cluster as one card and only the servers outside a cluster", () => {
  const html = grid({
    servers: [FREE, JOINING, SETTLED],
    clusters: [CLUSTER],
    openCluster: null,
  });
  assert.match(html, /eu 2 servers · 1 provisioning/);
  assert.doesNotMatch(html, /Failover on/);
  assert.match(html, /server-a/);
  assert.doesNotMatch(html, /server-b|server-c/);
});

test("inside a cluster a server that just joined reads Provisioning until it works", () => {
  const html = grid({
    servers: [JOINING, SETTLED],
    clusters: [],
    openCluster: { id: "clu_eu", name: "eu" },
  });
  assert.match(html, /Servers \/ eu/);
  assert.equal(html.match(/Provisioning/g)?.length, 1);
  assert.match(html, /server-b/);
  assert.match(html, /server-c/);
});

test("the server the leader runs on carries a Leader tag, and only that one", () => {
  const html = grid({
    servers: [JOINING, SETTLED],
    clusters: [],
    openCluster: { id: "clu_eu", name: "eu" },
  });
  assert.equal(html.match(/Leader/g)?.length, 1);
  assert.match(html, /server-c 203\.0\.113\.10 Leader/);
});

test("a server's card leaves out its hardware and a lease the leader lost", () => {
  const fenced = server("server-d", {
    cluster: eu,
    member: memberState(member({ leaseState: "fenced" })),
  });
  const html = grid({
    servers: [fenced],
    clusters: [],
    openCluster: { id: "clu_eu", name: "eu" },
  });
  assert.doesNotMatch(html, /Not responding|cores|GB RAM|run twice/);
});

test("a search lists the servers of every cluster together", () => {
  const all = [FREE, JOINING, SETTLED];
  assert.deepEqual(
    listedServers(all, false, false).map((s) => s.id),
    ["server-a"],
  );
  assert.equal(listedServers(all, false, true).length, 3);
  assert.equal(listedServers([JOINING, SETTLED], true, false).length, 2);
});

test("a cluster card counts its servers, as a folder counts its Apps", () => {
  const says = (servers: number, provisioning = 0) =>
    clusterSummary({ servers, provisioning });
  assert.equal(says(0), "No servers yet");
  assert.equal(says(1), "1 server");
  assert.equal(says(3, 1), "3 servers · 1 provisioning");
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
