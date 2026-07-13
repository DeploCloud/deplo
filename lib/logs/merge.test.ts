import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeLogBurst } from "./merge";

/**
 * Following a crash-looping container means reattaching after every restart, and
 * every reattach replays `docker logs --tail`. These cover the merge that keeps
 * the viewer from stuttering the same stack trace once per loop.
 */

test("first attach: the burst is the whole output", () => {
  assert.equal(mergeLogBurst("", "boot\nready\n"), "boot\nready\n");
});

test("a replayed tail that fully overlaps adds nothing", () => {
  const shown = "boot\nmigrating\nFATAL: relation exists\n";
  assert.equal(mergeLogBurst(shown, shown), shown);
});

test("a replayed tail keeps only the lines that came after it", () => {
  const shown = "boot\nmigrating\n";
  const burst = "boot\nmigrating\nFATAL: relation exists\n";
  assert.equal(mergeLogBurst(shown, burst), burst);
});

test("the next crash iteration appends, it does not duplicate the first", () => {
  const shown = "boot\nFATAL\n";
  // The restarted container replays its history and adds the new run's output.
  const burst = "boot\nFATAL\nboot\nFATAL\n";
  assert.equal(mergeLogBurst(shown, burst), "boot\nFATAL\nboot\nFATAL\n");
});

test("output we no longer have in the tail window is treated as all-new", () => {
  // Our anchor scrolled out of docker's --tail window: nothing to align on, so
  // every byte of the burst is output the viewer has not shown.
  const shown = "very old line\n";
  const burst = "newer\nnewest\n";
  assert.equal(mergeLogBurst(shown, burst), "very old line\nnewer\nnewest\n");
});

test("a partial trailing line still anchors the merge", () => {
  const shown = "boot\nconnecting to db";
  const burst = "boot\nconnecting to db… refused\nretrying\n";
  assert.equal(
    mergeLogBurst(shown, burst),
    "boot\nconnecting to db… refused\nretrying\n",
  );
});

test("an empty burst leaves the output untouched", () => {
  assert.equal(mergeLogBurst("boot\n", ""), "boot\n");
});

test("merging is idempotent as a burst arrives split across chunks", () => {
  const shown = "boot\nmigrating\n";
  const whole = "boot\nmigrating\nFATAL\n";
  // The route delivers the tail in arbitrary chunks; re-merging from the same
  // baseline on each chunk must converge on the same text as one burst would.
  let acc = "";
  let out = shown;
  for (const chunk of ["boot\nmig", "rating\nFA", "TAL\n"]) {
    acc += chunk;
    out = mergeLogBurst(shown, acc);
  }
  assert.equal(out, whole);
});
