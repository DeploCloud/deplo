import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "./db/test-harness";
import { __setTestDb, __resetTestDb } from "./db/client";
import { rateLimit, sweepRateLimits } from "./security";

/**
 * The rate limiter, which is what stands between a public mutation and an
 * unlimited number of password guesses.
 *
 * These tests exist because of what the previous implementation could not do,
 * not because counting to eight is hard. It kept its buckets in a
 * process-global `Map`, so a restart handed every account a fresh allowance -
 * "8 attempts per address per minute" was really "8 per restart" to anyone who
 * could make the control plane restart - and two instances against one database
 * each kept their own, silently multiplying every limit. So the load-bearing
 * case here is `survives a restart`: it drops the whole module's state the way a
 * restart does and asserts the count carried on.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("delete from rate_limits");
});

test("counts up to the limit, then refuses", async () => {
  const key = "test:steady";
  for (let i = 1; i <= 3; i++) {
    const r = await rateLimit(key, { limit: 3, windowMs: 60_000 });
    assert.equal(r.ok, true, `attempt ${i} must be allowed`);
    assert.equal(r.remaining, 3 - i);
  }
  const over = await rateLimit(key, { limit: 3, windowMs: 60_000 });
  assert.equal(over.ok, false);
  assert.equal(over.remaining, 0);
  assert.ok(over.retryAfterSec > 0, "a refusal must say how long to wait");
});

test("separate keys are separate buckets", async () => {
  await rateLimit("test:a", { limit: 1, windowMs: 60_000 });
  const a = await rateLimit("test:a", { limit: 1, windowMs: 60_000 });
  const b = await rateLimit("test:b", { limit: 1, windowMs: 60_000 });
  assert.equal(a.ok, false, "the exhausted key stays exhausted");
  assert.equal(b.ok, true, "a different key is untouched");
});

test("the count SURVIVES a restart", async () => {
  // The whole reason this moved out of memory. `__resetTestDb` + `__setTestDb`
  // is as close as this harness gets to dropping every module-level variable
  // the process was holding; if the counter lived in one, the second half of
  // this test would start from zero and pass three more attempts.
  const key = "test:restart";
  for (let i = 0; i < 3; i++)
    await rateLimit(key, { limit: 3, windowMs: 60_000 });

  __resetTestDb();
  __setTestDb(db);

  const after = await rateLimit(key, { limit: 3, windowMs: 60_000 });
  assert.equal(after.ok, false, "a restart must not reset the allowance");
});

test("a closed window starts a fresh allowance", async () => {
  const key = "test:expiry";
  // A one-millisecond window is floored to a second by the limiter, so the row
  // is aged directly instead - the same state the clock would reach, without
  // making the suite wait for it.
  await rateLimit(key, { limit: 1, windowMs: 60_000 });
  assert.equal(
    (await rateLimit(key, { limit: 1, windowMs: 60_000 })).ok,
    false,
  );

  await pg.exec(
    `update rate_limits set reset_at = now() - interval '1 second'`,
  );

  const reopened = await rateLimit(key, { limit: 1, windowMs: 60_000 });
  assert.equal(reopened.ok, true, "the window closed, so the count restarts");
  assert.equal(reopened.remaining, 0);
});

test("concurrent attempts are all counted", async () => {
  // The old read-modify-write on a Map was only ever safe because of the
  // single-threaded event loop; two instances would both have read the same
  // count and both written count+1. One UPSERT cannot do that, and this is what
  // says so: ten parallel attempts against a limit of ten leave exactly one
  // refusal for the eleventh, never a bucket that lost writes.
  const key = "test:concurrent";
  await Promise.all(
    Array.from({ length: 10 }, () =>
      rateLimit(key, { limit: 10, windowMs: 60_000 }),
    ),
  );
  const over = await rateLimit(key, { limit: 10, windowMs: 60_000 });
  assert.equal(over.ok, false, "ten attempts must consume the whole allowance");
});

test("the sweep removes closed windows and leaves open ones", async () => {
  await rateLimit("test:old", { limit: 5, windowMs: 60_000 });
  await pg.exec(
    `update rate_limits set reset_at = now() - interval '1 second'`,
  );
  await rateLimit("test:fresh", { limit: 5, windowMs: 60_000 });

  await sweepRateLimits();

  const rows = await pg.query<{ key: string }>(`select "key" from rate_limits`);
  assert.deepEqual(
    rows.rows.map((r) => r.key),
    ["test:fresh"],
  );
});

test("a limit of zero refuses the very first attempt", async () => {
  // Nothing configures this today, but a limiter whose floor is off by one is
  // the kind of thing that only shows up the day somebody sets it to zero.
  const r = await rateLimit("test:zero", { limit: 0, windowMs: 60_000 });
  assert.equal(r.ok, false);
});
