import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import type { ClusterLeader } from "@/lib/types/cluster";
import { MoveLeaderLead } from "./cluster-actions";
import { FailoverNote, LeaderView } from "./cluster-card";
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
  ownServerWarning: "",
  ...over,
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const card = (l: ClusterLeader, servers = 3) =>
  text(
    renderServerView(
      createElement(LeaderView, {
        clusterId: "clu_1",
        leader: l,
        choices: [],
        servers,
      }),
    ),
  );

test("a leader that answers says whether a failover would work right now", () => {
  const ready = card(leader());
  assert.match(ready, /Leader runs on server-a Answering/);
  assert.match(ready, /Failover would work right now\./);
});

test("a leader that hears too few servers never reads Answering", () => {
  const message =
    "Only 1 of 3 servers answers this leader, so nothing moves. Failover works again once 2 do.";
  const few = card(leader({ failoverReady: false, message }));
  assert.match(few, /Leader runs on server-a Too few servers answer/);
  assert.doesNotMatch(few, /Answering|would work right now/);
  assert.ok(few.includes(message));
});

test("a single server, or a leader that does not run, promises nothing", () => {
  assert.doesNotMatch(
    card(leader({ failoverReady: null }), 1),
    /would work right now/,
  );
  const stopped = card(
    leader({
      state: "stopped",
      failoverReady: false,
      message: "The leader is installed but not running.",
    }),
  );
  assert.match(stopped, /Not running/);
  assert.doesNotMatch(stopped, /would work right now|Too few/);
});

test("two servers say that failover needs Deplo up, and three say nothing", () => {
  const note = (servers: number) =>
    text(renderServerView(createElement(FailoverNote, { servers })));
  assert.match(
    note(2),
    /With two servers, failover works only while Deplo is up\. With three, and the leader on one of them, it also works while Deplo is down\./,
  );
  assert.equal(note(1).trim(), "");
  assert.equal(note(3).trim(), "");
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
