import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __forgetTurns,
  busyWith,
  queuedNote,
  setReplicaTurns,
  takeTurn,
  turnWait,
} from "./copy-turns";

test("a copy waits while either of its servers copies something else, says why once, then holds both", async () => {
  __forgetTurns();
  turnWait.pollMs = 5;
  setReplicaTurns(new Map([["srv_2", "a copy of web"]]));
  const heard: string[] = [];
  let got = false;
  const turn = takeTurn(["srv_1", "srv_2"], "a backup of shop", {
    note: "brun_1",
    queued: (id, what) => void heard.push(`${id}: ${what}`),
  }).then((release) => ((got = true), release));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got, false, "srv_2 still copies web");
  assert.deepEqual(heard, ["srv_2: a copy of web"]);
  assert.deepEqual(queuedNote("brun_1"), {
    serverId: "srv_2",
    what: "a copy of web",
  });

  setReplicaTurns(new Map());
  const release = await turn;
  assert.equal(queuedNote("brun_1"), null);
  assert.equal(busyWith("srv_1"), "a backup of shop");
  assert.equal(busyWith("srv_2"), "a backup of shop");
  release();
  assert.equal(busyWith("srv_1"), null);
});

test("a stuck copy holds another at most its limit, and a cancel ends the wait", async () => {
  __forgetTurns();
  turnWait.pollMs = 5;
  const was = turnWait.maxMs;
  turnWait.maxMs = 20;
  setReplicaTurns(new Map([["srv_1", "a copy of web"]]));
  (await takeTurn(["srv_1"], "a backup of shop"))();
  turnWait.maxMs = was;
  const stop = new AbortController();
  const waiting = takeTurn(["srv_1"], "the move of shop", {
    signal: stop.signal,
  });
  stop.abort();
  (await waiting)();
  __forgetTurns();
});
