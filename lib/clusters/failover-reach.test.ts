import { test } from "node:test";
import assert from "node:assert/strict";

import {
  leaderHearsEnough,
  leaseSentence,
  stoppedSentence,
  tooFewSentence,
} from "./failover-reach";

test("a leader moves work with more than half answering, or exactly half while Deplo is up", () => {
  const enough = (answering: number, total: number) =>
    leaderHearsEnough(answering, total);
  assert.deepEqual(
    [enough(1, 2), enough(2, 3), enough(2, 4), enough(3, 5)],
    [true, true, true, true],
  );
  assert.deepEqual(
    [enough(0, 1), enough(0, 2), enough(1, 3), enough(1, 4), enough(2, 5)],
    [false, false, false, false, false],
  );
});

test("the card names how many servers answer and how many it takes", () => {
  assert.equal(
    tooFewSentence(1, 3),
    "Only 1 of 3 servers answers this leader, so nothing moves. Failover works again once 2 do.",
  );
  assert.equal(
    tooFewSentence(2, 5),
    "Only 2 of 5 servers answer this leader, so nothing moves. Failover works again once 3 do.",
  );
  assert.equal(
    tooFewSentence(0, 2),
    "None of the 2 servers answers this leader, so nothing moves. Failover works again once 1 does.",
  );
});

test("a silent server reads as silent only while the leader still hears enough of the others", () => {
  assert.equal(
    leaseSentence("server-b", "eu", "fenced", false),
    "server-b stopped responding in cluster eu, so it stopped the databases and Apps with files that must never run twice.",
  );
  assert.doesNotMatch(
    leaseSentence("server-b", "eu", "fenced", true),
    /has not responded/,
  );
  assert.equal(
    leaseSentence("server-b", "eu", "ok", true),
    "server-b answers again in cluster eu.",
  );
});

test("a member whose lease ran out is said as it is: what it had to stop, and whether it did", () => {
  assert.equal(
    stoppedSentence("eu-2", "eu", true, [], true),
    "Too few servers answer in cluster eu. eu-2 runs no database or App that must never run twice, so nothing on it had to stop.",
  );
  assert.equal(
    stoppedSentence("eu-3", "eu", true, ["memos"], true),
    "Too few servers answer in cluster eu, so eu-3 stopped memos: it must never run twice.",
  );
  assert.match(
    stoppedSentence("eu-3", "eu", false, ["memos", "db-main"], null),
    /stops memos and db-main on its own if it is still running; Deplo cannot reach it/,
  );
  assert.match(
    stoppedSentence("eu-3", "eu", true, ["memos"], false),
    /still runs memos/,
  );
});
