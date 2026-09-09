import { test } from "node:test";
import assert from "node:assert/strict";

import {
  forgetHttpHealth,
  httpHealthVerdict,
  recentHttpHealth,
  withinStartPeriod,
} from "./http-health";

/**
 * Deplo's own http probe has to keep Docker's rule, or a single blip would paint
 * a working app red: `retries` CONSECUTIVE failures, and a success forgets them.
 */

test("a check stays healthy until retries consecutive failures", () => {
  const app = "prj_streak";
  forgetHttpHealth(app);
  assert.equal(httpHealthVerdict(app, false, 3), "healthy");
  assert.equal(httpHealthVerdict(app, false, 3), "healthy");
  assert.equal(httpHealthVerdict(app, false, 3), "unhealthy");
  assert.equal(httpHealthVerdict(app, false, 3), "unhealthy");
});

test("one success forgets the streak", () => {
  const app = "prj_reset";
  forgetHttpHealth(app);
  httpHealthVerdict(app, false, 2);
  assert.equal(httpHealthVerdict(app, true, 2), "healthy");
  assert.equal(httpHealthVerdict(app, false, 2), "healthy");
});

test("retries below one still fails on the first miss", () => {
  const app = "prj_zero";
  forgetHttpHealth(app);
  assert.equal(httpHealthVerdict(app, false, 0), "unhealthy");
});

test("apps keep their own streak", () => {
  forgetHttpHealth("prj_a");
  forgetHttpHealth("prj_b");
  httpHealthVerdict("prj_a", false, 2);
  assert.equal(httpHealthVerdict("prj_b", false, 2), "healthy");
});

test("a booting container is starting, not failing", () => {
  const now = 1_000_000_000_000;
  const started = now / 1000 - 4;
  assert.equal(withinStartPeriod(started, 10, now), true);
  assert.equal(withinStartPeriod(started, 2, now), false);
  // An agent that does not report a start time must not be guessed at.
  assert.equal(withinStartPeriod(0, 30, now), false);
  assert.equal(withinStartPeriod(started, 0, now), false);
});

/**
 * `Interval` is the field that says how often the app is asked. Without it, the
 * probe would fire once per open page instead of once per interval.
 */
test("the verdict is reused until the interval has elapsed", () => {
  const app = "prj_interval";
  forgetHttpHealth(app);
  const t0 = 1_000_000;
  assert.equal(recentHttpHealth(app, 30, t0), null, "nothing asked yet");

  httpHealthVerdict(app, true, 3, t0);
  assert.equal(recentHttpHealth(app, 30, t0 + 5_000), "healthy");
  assert.equal(
    recentHttpHealth(app, 30, t0 + 31_000),
    null,
    "interval elapsed",
  );

  httpHealthVerdict(app, false, 1, t0);
  assert.equal(recentHttpHealth(app, 30, t0 + 1_000), "unhealthy");
  // No interval means no reuse: ask every time.
  assert.equal(recentHttpHealth(app, 0, t0 + 1_000), null);
});
