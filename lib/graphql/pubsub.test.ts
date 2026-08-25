import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeRemote, PUBSUB_INSTANCE } from "./pubsub";

/**
 * What a peer control plane is allowed to make this one publish.
 *
 * The bridge exists because a second process on the same database used to leave
 * every open page showing the last thing IT had heard - a migration that had
 * finished forty minutes earlier still reading "in progress". The decoder is the
 * only place a peer's bytes turn into a local event, so it is where "peer" has
 * to mean peer: not our own echo, not a channel we don't have, and not whatever
 * else happens to NOTIFY on a channel name that is just a string.
 */

const peer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    i: "some-other-control-plane",
    c: "migrationActivity",
    k: "instance",
    p: "instance",
    ...over,
  });

test("a peer's message is republished here", () => {
  assert.deepEqual(decodeRemote(peer()), {
    i: "some-other-control-plane",
    c: "migrationActivity",
    k: "instance",
    p: "instance",
  });
});

test("our own notification is not replayed into us", () => {
  assert.equal(decodeRemote(peer({ i: PUBSUB_INSTANCE })), null);
});

test("a channel this version does not have is ignored", () => {
  assert.equal(decodeRemote(peer({ c: "somethingElseChanged" })), null);
});

test("anything that is not one of ours is ignored", () => {
  for (const raw of [
    "",
    "not json",
    "null",
    '"a string"',
    "[]",
    JSON.stringify({ c: "appChanged", k: "prj_1", p: "prj_1" }), // no sender
    peer({ k: 42 }),
    peer({ p: undefined }),
  ])
    assert.equal(decodeRemote(raw), null, `should refuse ${raw}`);
});
