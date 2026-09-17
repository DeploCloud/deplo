import assert from "node:assert/strict";
import test from "node:test";

import {
  RESTART_LOOP_THRESHOLD,
  RESTART_LOOP_WINDOW_MS,
  forgetContainers,
  loopingContainers,
} from "./restart-loop";

const sample = (restartCount: number, containerId = "aaa") => [
  { name: "deplo-web-1", containerId, state: "restarting", restartCount },
];

test("a container that climbs past the threshold inside the window is looping", () => {
  const t0 = 1_000_000;
  assert.deepEqual(loopingContainers("s1", sample(3), t0), []);
  assert.deepEqual(
    loopingContainers(
      "s1",
      sample(3 + RESTART_LOOP_THRESHOLD - 1),
      t0 + 60_000,
    ),
    [],
    "one short of the threshold must not trip",
  );
  assert.deepEqual(
    loopingContainers("s1", sample(3 + RESTART_LOOP_THRESHOLD), t0 + 120_000),
    ["deplo-web-1"],
  );
});

test("a container first seen already high does not trip on the spot", () => {
  const t0 = 2_000_000;
  assert.deepEqual(
    loopingContainers("s2", sample(500), t0),
    [],
    "only restarts witnessed inside the window count",
  );
  assert.deepEqual(loopingContainers("s2", sample(509), t0 + 60_000), []);
  assert.deepEqual(loopingContainers("s2", sample(510), t0 + 90_000), [
    "deplo-web-1",
  ]);
});

test("a recreated container starts a new life", () => {
  const t0 = 3_000_000;
  loopingContainers("s3", sample(0, "old"), t0);
  assert.deepEqual(
    loopingContainers("s3", sample(RESTART_LOOP_THRESHOLD, "new"), t0 + 60_000),
    [],
    "a deploy recreates the container, and its count is not the old one's",
  );
});

test("restarts spread past the window do not add up", () => {
  const t0 = 4_000_000;
  loopingContainers("s4", sample(0), t0);
  const later = t0 + RESTART_LOOP_WINDOW_MS + 1;
  assert.deepEqual(loopingContainers("s4", sample(9), later), []);
  assert.deepEqual(
    loopingContainers("s4", sample(9 + RESTART_LOOP_THRESHOLD - 1), later + 1),
    [],
    "the baseline rebased at the window edge, so the old restarts are gone",
  );
});

test("a container that leaves the host is forgotten", () => {
  const t0 = 5_000_000;
  loopingContainers("s5", sample(0), t0);
  loopingContainers("s5", [], t0 + 1000);
  assert.deepEqual(
    loopingContainers("s5", sample(RESTART_LOOP_THRESHOLD), t0 + 2000),
    [],
    "it is seen for the first time again, so its count is a fresh baseline",
  );
});

test("forgetContainers clears what a stop left behind", () => {
  const t0 = 6_000_000;
  loopingContainers("s6", sample(0), t0);
  forgetContainers("s6", ["deplo-web-1"]);
  assert.deepEqual(
    loopingContainers("s6", sample(RESTART_LOOP_THRESHOLD), t0 + 1000),
    [],
  );
});

test("one server's containers never count against another's", () => {
  const t0 = 7_000_000;
  loopingContainers("s7a", sample(0), t0);
  assert.deepEqual(
    loopingContainers("s7b", sample(RESTART_LOOP_THRESHOLD), t0 + 1000),
    [],
  );
});
