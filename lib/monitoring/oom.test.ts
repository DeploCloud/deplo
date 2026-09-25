import { test } from "node:test";
import assert from "node:assert/strict";

import { newOomKills } from "./oom";

const web = (oomKills: number, containerId = "c1") => ({
  name: "web",
  containerId,
  oomKills,
});

test("an oom kill is reported once, when the count climbs", () => {
  const srv = "srv_oom_1";
  assert.deepEqual(newOomKills(srv, [web(0)]), []);
  assert.deepEqual(newOomKills(srv, [web(1)]), [web(1)]);
  assert.deepEqual(newOomKills(srv, [web(1)]), []);
  assert.deepEqual(newOomKills(srv, [web(3)]), [web(3)]);
});

test("the first sighting is a baseline, not an alert", () => {
  assert.deepEqual(newOomKills("srv_oom_2", [web(4)]), []);
});

test("a recreated container starts a new baseline", () => {
  const srv = "srv_oom_3";
  newOomKills(srv, [web(2, "c1")]);
  assert.deepEqual(newOomKills(srv, [web(1, "c2")]), []);
  assert.deepEqual(newOomKills(srv, [web(2, "c2")]), [web(2, "c2")]);
});

test("an agent too old to count reports nothing", () => {
  const srv = "srv_oom_4";
  newOomKills(srv, [web(0)]);
  assert.deepEqual(newOomKills(srv, [web(0)]), []);
});

test("a container that left the host forgets its count", () => {
  const srv = "srv_oom_5";
  newOomKills(srv, [web(1)]);
  newOomKills(srv, []);
  assert.deepEqual(newOomKills(srv, [web(2)]), []);
});

test("servers do not share baselines", () => {
  newOomKills("srv_oom_6", [web(0)]);
  assert.deepEqual(newOomKills("srv_oom_7", [web(1)]), []);
  assert.deepEqual(newOomKills("srv_oom_6", [web(1)]), [web(1)]);
});
