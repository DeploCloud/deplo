import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import type { ClusterLeader } from "@/lib/types/cluster";
import { MoveLeaderLead } from "./cluster-actions";
import { ClusterNoticeList } from "./cluster-panel";
import { clusterWarnings } from "@/lib/clusters/warnings";
import { renderServerView } from "./server-test-helpers";

const leader = (over: Partial<ClusterLeader> = {}): ClusterLeader => ({
  serverId: "srv_1",
  serverName: "server-a",
  onDeploHost: true,
  state: "running",
  version: "0.2.0",
  message: "",
  failoverReady: true,
  takenOverAt: null,
  updateMessage: "",
  relayMessage: "",
  ownServerWarning: "",
  ...over,
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const warn = (over: Partial<Parameters<typeof clusterWarnings>[0]> = {}) =>
  clusterWarnings({
    failoverEnabled: true,
    servers: 3,
    leader: leader(),
    waiting: [],
    copies: [],
    ...over,
  });

test("a cluster whose failover works says nothing", () => {
  assert.deepEqual(warn(), []);
});

test("a leader that cannot fail over is a warning, and one Deplo can start offers to", () => {
  const few = warn({
    leader: leader({
      failoverReady: false,
      message: "Only 1 of 3 servers answers this leader, so nothing moves.",
    }),
  });
  assert.equal(few.length, 1);
  assert.equal(few[0].title, "Failover is not working right now");
  assert.equal(few[0].startLeader, undefined);

  const stopped = warn({
    leader: leader({ state: "stopped", message: "The leader is not running." }),
  });
  assert.equal(stopped[0].body, "The leader is not running.");
  assert.equal(stopped[0].startLeader, true);
  assert.equal(warn({ leader: null })[0].key, "leader");
});

test("each thing that may stop failover is its own banner", () => {
  const relayMessage = "Servers may not reach the relay on Deplo's machine.";
  const all = warn({
    leader: leader({
      relayMessage,
      updateMessage: "Deplo could not update the leader.",
      takenOverAt: "2026-11-14T00:00:00.000Z",
    }),
    copies: [{ appId: "a", appName: "web", held: 2, total: 3 }],
  });
  assert.deepEqual(
    all.map((w) => w.key),
    ["takeover", "update", "relay", "copies"],
  );
  assert.ok(all.some((w) => w.body === relayMessage));
  assert.match(all.at(-1)!.body, /web on 2 of 3 servers/);
});

test("failover off hides its trouble, but an App left waiting still shows", () => {
  const off = warn({
    failoverEnabled: false,
    leader: leader({ state: "unreachable" }),
    waiting: ["web", "api"],
  });
  assert.deepEqual(
    off.map((w) => w.title),
    ["2 Apps waiting for room"],
  );
});

test("failover on with one server says it needs a second", () => {
  const one = warn({ servers: 1, leader: leader({ state: "unreachable" }) });
  assert.deepEqual(
    one.map((w) => w.key),
    ["one-server"],
  );
  assert.deepEqual(warn({ servers: 0 }), []);
});

test("the banners read like an App's, and none renders nothing", () => {
  const html = text(
    renderServerView(
      createElement(ClusterNoticeList, {
        clusterId: "clu_1",
        warnings: warn({
          leader: leader({ state: "stopped", message: "Down." }),
        }),
      }),
    ),
  );
  assert.match(html, /Failover is not working right now Down\. Try again/);
  assert.equal(
    renderServerView(
      createElement(ClusterNoticeList, { clusterId: "clu_1", warnings: [] }),
    ),
    "",
  );
});

test("the leader dialog only promises failover without Deplo from three servers", () => {
  const lead = (servers: number) =>
    text(renderServerView(createElement(MoveLeaderLead, { servers })));
  assert.match(
    lead(3),
    /Failover keeps working while Deplo's own machine is down \./,
  );
  assert.match(
    lead(2),
    /Under three servers, failover still needs Deplo up wherever the leader runs\./,
  );
  assert.doesNotMatch(lead(2), /keeps working/);
});
