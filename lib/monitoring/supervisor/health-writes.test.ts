import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HEALTH_WRITE_MS,
  STREAM_INTERVAL_MS,
  __setMetricsConnectorForTest,
  startMetricsStreams,
} from "../supervisor";
import {
  Feed,
  SRV_A,
  frame,
  hello,
  seedEnrolledServer,
  setupSupervisor,
  statusCheckedAt,
  waitFor,
} from "./supervisor-test-helpers";

const h = setupSupervisor();

test("HEALTH_WRITE_MS stays under the prober's 15s THROTTLE_MS, or the prober silently re-enables its fleet-wide dial fan-out", () => {
  // THROTTLE_MS in lib/data/server-health.ts is 15000 and is NOT exported - restated here, the only place it is visible.
  const PROBER_THROTTLE_MS = 15_000;
  assert.ok(
    HEALTH_WRITE_MS < PROBER_THROTTLE_MS,
    `HEALTH_WRITE_MS (${HEALTH_WRITE_MS}) must stay under the prober's throttle (${PROBER_THROTTLE_MS})`,
  );

  // That alone is NOT enough: the heartbeat fires only when a frame arrives, so its real period is a MULTIPLE of the cadence.
  const EARLY_FRAME_TOLERANCE_MS = 100;
  const effectivePeriod =
    Math.ceil(
      (HEALTH_WRITE_MS + EARLY_FRAME_TOLERANCE_MS) / STREAM_INTERVAL_MS,
    ) * STREAM_INTERVAL_MS;
  assert.ok(
    effectivePeriod < PROBER_THROTTLE_MS,
    `HEALTH_WRITE_MS (${HEALTH_WRITE_MS}) at a ${STREAM_INTERVAL_MS}ms cadence writes every ` +
      `${effectivePeriod}ms once a frame lands early - that must stay under ${PROBER_THROTTLE_MS}ms. ` +
      `Keep HEALTH_WRITE_MS strictly BETWEEN one and two cadences.`,
  );
});

test("health is written AT MOST once per 10s and AT LEAST once per 15s under a 5s frame rate", async () => {
  // The UPPER bound is the saving: a write per frame would put the fleet's DB churn back on the 5s cadence.
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");

  // The supervisor throttles off `Date.now()`, so 40s of stream is an advanced clock, not a 40s wait.
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;

  try {
    const feed = new Feed();
    __setMetricsConnectorForTest(async () => ({
      conn: feed.connection(),
      hello: hello(),
    }));
    startMetricsStreams();
    // Wait for the CONNECT-time write, which seeds `lastHealthWriteAt`: advancing the clock first is non-deterministic.
    await waitFor(
      async () => (await statusCheckedAt(h.db, SRV_A)) !== null,
      "the opening health write",
    );

    const writes: number[] = [];
    let lastSeen = await statusCheckedAt(h.db, SRV_A);

    for (let i = 0; i < 8; i++) {
      clock += 5_000; // 8 frames x 5s = 40s of stream time
      await feed.send(frame());
      const at = await statusCheckedAt(h.db, SRV_A);
      if (at !== lastSeen) {
        lastSeen = at;
        writes.push(clock);
      }
    }

    // Pinned exactly so neither bound below can pass vacuously.
    assert.equal(
      writes.length,
      4,
      "8 frames over 40s must yield exactly 4 heartbeats, not 8 and not 1",
    );

    // UPPER bound: never more often than every HEALTH_WRITE_MS.
    for (let i = 1; i < writes.length; i++) {
      const delta = writes[i] - writes[i - 1];
      assert.ok(
        delta >= HEALTH_WRITE_MS,
        `two health writes ${delta}ms apart - the ${HEALTH_WRITE_MS}ms throttle is not holding`,
      );
    }

    // LOWER bound: no stretch longer than the prober's throttle without a write, tail after the last frame included.
    const PROBER_THROTTLE_MS = 15_000;
    let previous = clock - 40_000; // the connect-time write
    for (const w of [...writes, clock]) {
      assert.ok(
        w - previous <= PROBER_THROTTLE_MS,
        `${w - previous}ms passed with no health write - the prober's throttle would lapse`,
      );
      previous = w;
    }
  } finally {
    Date.now = realNow;
  }
});
