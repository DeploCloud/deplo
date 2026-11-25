import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __forgetTurns,
  busyWith,
  lineOf,
  joinLine,
  leaveLine,
  mayGo,
  placeOf,
  placeWords,
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
    place: 1,
    serverId: "srv_2",
    what: "a copy of web",
    busy: true,
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

// c39: lab-r's backup waited 12 minutes while copies and backups that asked after it took every turn.
test("copies go in the order they asked, whatever kind, and each says its place", async () => {
  __forgetTurns();
  turnWait.pollMs = 5;
  setReplicaTurns(new Map([["srv_1", "a copy of web"]]));
  const went: string[] = [];
  const ask = (what: string, note: string) =>
    takeTurn(["srv_1"], what, { note }).then((release) => {
      went.push(what);
      return release;
    });
  const first = ask("a backup of shop", "brun_1");
  await new Promise((r) => setTimeout(r, 15));
  const second = ask("a backup of blog", "brun_2");
  await new Promise((r) => setTimeout(r, 15));
  // A copy the replication pass hands later waits behind both, though srv_1 is free once web is whole.
  joinLine(
    "srv_1|prj_3",
    ["srv_1", "srv_3"],
    "a copy of wiki",
    "replica:clu_1",
  );
  assert.deepEqual(queuedNote("brun_1"), {
    place: 1,
    serverId: "srv_1",
    what: "a copy of web",
    busy: true,
  });
  assert.equal(queuedNote("brun_2")!.place, 2);
  assert.equal(
    placeWords(placeOf("srv_1|prj_3")!, "eu-1"),
    "3rd in line: eu-1 is busy with a copy of web",
  );
  setReplicaTurns(new Map());
  const release1 = await first;
  assert.equal(
    mayGo("srv_1|prj_3", () => null),
    false,
    "two asked before it",
  );
  release1();
  const release2 = await second;
  assert.deepEqual(went, ["a backup of shop", "a backup of blog"]);
  release2();
  assert.equal(mayGo("srv_1|prj_3"), true, "its turn once both are done");
  leaveLine("srv_1|prj_3");
  __forgetTurns();
});

test("a copy waits only for those before it that share one of its servers", () => {
  __forgetTurns();
  joinLine("a", ["srv_1", "srv_2"], "a copy of web", "replica:clu_1");
  joinLine("b", ["srv_3"], "a copy of blog", "replica:clu_1");
  joinLine("c", ["srv_2"], "a backup of shop", "backup");
  assert.equal(
    mayGo("b", () => null),
    true,
  );
  assert.equal(
    mayGo("c", () => null),
    false,
  );
  assert.equal(
    placeWords(
      placeOf("c", () => null)!,
      "eu-2",
    ),
    "2nd in line: eu-2 takes a copy of web first",
  );
  assert.deepEqual(lineOf("replica:clu_1"), ["a", "b"]);
  __forgetTurns();
});
