import test from "node:test";
import assert from "node:assert/strict";

import {
  reviewShows,
  stepReachable,
  stepsFor,
  type StepId,
  type StepProgress,
  type TakeoverMode,
} from "./steps";

const ids = (
  canInvite: boolean,
  canTakeOver: boolean,
  mode: TakeoverMode | null = "migrate",
) => stepsFor(canInvite, canTakeOver, mode).map((s) => s.id);

test("the plain migration ends on the report", () => {
  assert.deepEqual(ids(true, false), [
    "connect",
    "install",
    "review",
    "people",
    "done",
  ]);
});

// Both of People's actions are instance-admin gated, so for anyone else the step
// would be a page of nothing.
test("People is an instance admin's step", () => {
  assert.deepEqual(ids(false, false), ["connect", "install", "review", "done"]);
});

// Taking the ports is the LAST thing a person does, and Done is what follows it.
test("a takeover chooses first and takes over last", () => {
  assert.deepEqual(ids(true, true), [
    "choose",
    "connect",
    "install",
    "review",
    "people",
    "takeover",
    "done",
  ]);
  assert.deepEqual(ids(false, true).slice(-2), ["takeover", "done"]);
  assert.equal(ids(false, true)[0], "choose");
});

test("a clean takeover has nothing to connect to", () => {
  assert.deepEqual(ids(true, true, "clean"), ["choose", "takeover", "done"]);
});

test("nothing has been chosen yet, so the rail shows the migration", () => {
  assert.deepEqual(ids(true, true, null), ids(true, true, "migrate"));
});

test("every step is labelled", () => {
  for (const s of [...stepsFor(true, true), ...stepsFor(true, true, "clean")])
    assert.ok(s.label.length > 0, `${s.id} has no label`);
  assert.equal(
    stepsFor(true, true).find((s) => s.id === "takeover")?.label,
    "Take over",
  );
});

/* ---- the gate ------------------------------------------------------ */

const NOTHING: StepProgress = {
  mode: null,
  isTakeover: true,
  plan: false,
  machinesReady: false,
  runId: null,
  reportDone: false,
  teamsLeft: 0,
  inFlight: false,
  takeoverDone: false,
};

const open = (at: Partial<StepProgress>): StepId[] =>
  (
    [
      "choose",
      "connect",
      "install",
      "review",
      "people",
      "takeover",
      "done",
    ] as StepId[]
  ).filter((s) => stepReachable(s, { ...NOTHING, ...at }));

test("a fresh takeover opens on the choice and nothing else", () => {
  assert.deepEqual(open({}), ["choose", "connect"]);
});

test("Install waits for a scan, Review for the machines", () => {
  assert.deepEqual(open({ mode: "migrate", plan: true }), [
    "choose",
    "connect",
    "install",
  ]);
  assert.ok(
    stepReachable("review", {
      ...NOTHING,
      mode: "migrate",
      plan: true,
      machinesReady: true,
    }),
  );
});

// The whole point of the gate: no card explaining a disabled button, the step
// simply is not there yet.
test("Take over is closed until a run has finished", () => {
  const at = { mode: "migrate" as const, plan: true, machinesReady: true };
  assert.equal(stepReachable("takeover", { ...NOTHING, ...at }), false);
  assert.equal(
    stepReachable("takeover", { ...NOTHING, ...at, runId: "dimp_1" }),
    false,
  );
  assert.ok(
    stepReachable("takeover", {
      ...NOTHING,
      ...at,
      runId: "dimp_1",
      reportDone: true,
    }),
  );
});

test("a team still queued holds the takeover", () => {
  assert.equal(
    stepReachable("takeover", {
      ...NOTHING,
      mode: "migrate",
      reportDone: true,
      teamsLeft: 1,
    }),
    false,
  );
});

test("a clean takeover is open straight away", () => {
  assert.deepEqual(open({ mode: "clean" }), ["choose", "takeover"]);
});

test("nothing but Review while a run is moving", () => {
  assert.deepEqual(
    open({
      mode: "migrate",
      plan: true,
      machinesReady: true,
      runId: "dimp_1",
      inFlight: true,
    }),
    ["review"],
  );
});

test("Done is the machine changing hands, not the report", () => {
  const at = { mode: "clean" as const, reportDone: true };
  assert.equal(stepReachable("done", { ...NOTHING, ...at }), false);
  assert.ok(stepReachable("done", { ...NOTHING, ...at, takeoverDone: true }));
  // Off a takeover the report IS the end.
  assert.ok(
    stepReachable("done", { ...NOTHING, isTakeover: false, reportDone: true }),
  );
});

test("the choice is gone once a run exists", () => {
  assert.equal(
    stepReachable("choose", { ...NOTHING, mode: "migrate", runId: "dimp_1" }),
    false,
  );
});

/* ---- what Review is showing ---------------------------------------- */

const REVIEW = {
  running: false,
  runId: null as string | null,
  failure: null as string | null,
  report: false,
  plan: true,
};

test("Review shows the plan until something is started", () => {
  assert.equal(reviewShows(REVIEW), "plan");
  assert.equal(reviewShows({ ...REVIEW, plan: false }), null);
});

// The bug: the start call landed, the subscription had not caught up, and the
// plan came back with a live Start button under a run that was already going.
test("a run this tab cannot see yet still owns Review", () => {
  assert.equal(reviewShows({ ...REVIEW, running: true }), "moving");
  assert.equal(reviewShows({ ...REVIEW, runId: "dimp_1" }), "moving");
});

test("a start that was refused says so rather than re-offering itself", () => {
  assert.equal(reviewShows({ ...REVIEW, failure: "nope" }), "moving");
});

test("the report wins over the run that produced it", () => {
  assert.equal(
    reviewShows({ ...REVIEW, runId: "dimp_1", report: true }),
    "report",
  );
});
