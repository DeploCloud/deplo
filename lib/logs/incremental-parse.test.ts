import { test } from "node:test";
import assert from "node:assert/strict";

import {
  advanceParse,
  capText,
  emptyParse,
  type ParseState,
} from "./incremental-parse";

type L = { text: string };

function counting() {
  let calls = 0;
  return {
    classify: (raw: string): L => {
      calls++;
      return { text: raw };
    },
    get calls() {
      return calls;
    },
  };
}

function full(text: string, max = 100): ParseState<L> {
  return advanceParse(emptyParse<L>(), text, 0, (raw) => ({ text: raw }), max);
}

test("appending parses only the new lines", () => {
  const c = counting();
  let s = advanceParse(emptyParse<L>(), "a\nb\n", 0, c.classify, 100);
  s = advanceParse(s, "a\nb\nc\npart", 0, c.classify, 100);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["a", "b", "c"],
  );
  assert.equal(c.calls, 3);
  assert.equal(s.text.slice(s.parsedTo), "part");
});

test("a front trim drops the matching lines instead of re-parsing", () => {
  const c = counting();
  let s = advanceParse(
    emptyParse<L>(),
    "one\ntwo\nthree\n",
    0,
    c.classify,
    100,
  );
  const uncapped = s.text + "four\n";
  const capped = capText(uncapped, 12);
  s = advanceParse(s, capped, uncapped.length - capped.length, c.classify, 100);
  assert.equal(capped, "three\nfour\n");
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["three", "four"],
  );
  assert.equal(c.calls, 4, "only the new line was classified");
  assert.deepEqual(s, full(capped));
});

test("a trim inside lines already past maxLines only lowers the skip count", () => {
  let s = full("1\n2\n3\n4\n", 2);
  assert.equal(s.skipped, 2);
  s = advanceParse(s, "2\n3\n4\n5\n", 2, (raw) => ({ text: raw }), 2);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["4", "5"],
  );
  assert.equal(s.skipped, 2);
});

test("a rewrite that is not a trim or an append re-parses from scratch", () => {
  const c = counting();
  let s = advanceParse(emptyParse<L>(), "a\nb\n", 0, c.classify, 100);
  s = advanceParse(s, "x\ny\n", 0, c.classify, 100);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["x", "y"],
  );
  s = advanceParse(s, "y\n", 1, c.classify, 100);
  assert.deepEqual(s, full("y\n"), "a mid-line cut re-parses");
  assert.deepEqual(advanceParse(s, "", 0, c.classify, 100), emptyParse());
});
