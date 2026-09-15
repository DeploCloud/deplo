import { test } from "node:test";
import assert from "node:assert/strict";

import { getMetricsHistory } from "../history";
import {
  RECONNECT_BACKOFF_CAP_MS,
  __setMetricsConnectorForTest,
  backoffFor,
  startMetricsStreams,
} from "../supervisor";
import {
  Feed,
  SRV_A,
  frame,
  hello,
  seedEnrolledServer,
  setupSupervisor,
  waitFor,
} from "./supervisor-test-helpers";

const h = setupSupervisor();

test("reconnect backoff grows exponentially and is CAPPED at RECONNECT_BACKOFF_CAP_MS", () => {
  const JITTER = 1.2;

  for (let attempt = 0; attempt < 4; attempt++) {
    const base = Math.min(RECONNECT_BACKOFF_CAP_MS, 1000 * 2 ** attempt);
    const v = backoffFor(attempt);
    assert.ok(
      v >= Math.max(250, base * 0.8) && v <= base * JITTER,
      `backoffFor(${attempt}) = ${v} must sit within +/-20% of ${base}`,
    );
  }

  for (const attempt of [10, 16, 64, 1024]) {
    const v = backoffFor(attempt);
    assert.ok(
      Number.isFinite(v) && v <= RECONNECT_BACKOFF_CAP_MS * JITTER,
      `backoffFor(${attempt}) = ${v} must not exceed the ${RECONNECT_BACKOFF_CAP_MS}ms cap`,
    );
  }
});

test("reconnect attempts are UNBOUNDED - a host down for an hour reconnects when it returns", async () => {
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");

  const held: { feed: Feed | null } = { feed: null };
  let attempts = 0;
  __setMetricsConnectorForTest(async () => {
    attempts++;
    if (attempts < 3) throw new Error("host is down");
    held.feed = new Feed();
    return { conn: held.feed.connection(), hello: hello() };
  });

  startMetricsStreams();
  await waitFor(() => attempts >= 3, "the third dial, after two failures", 600);
  await waitFor(() => held.feed !== null, "the recovered connection");
  await held.feed!.send(frame());
  assert.equal(
    getMetricsHistory(SRV_A).length,
    1,
    "telemetry resumes on its own once the host answers again",
  );
});
