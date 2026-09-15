import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  canAcquire,
  acquireLease,
  ownedByDeadLocalProcess,
  releaseLease,
  __resetLocalLeases,
  LEASE_STALE_MS,
  type LeaseRow,
} from "./lease";

const NOW = new Date("2026-06-23T12:00:00Z");

test("canAcquire: a fresh lease (no row) is claimable", () => {
  assert.equal(canAcquire(null, "me", NOW), true);
});

test("canAcquire: the current owner renews (idempotent heartbeat)", () => {
  const row: LeaseRow = { owner: "me", heartbeatAt: NOW };
  assert.equal(canAcquire(row, "me", NOW), true);
});

test("canAcquire: a live foreign owner blocks", () => {
  const row: LeaseRow = { owner: "other", heartbeatAt: NOW };
  assert.equal(canAcquire(row, "me", NOW), false);
});

test("canAcquire: a foreign owner just inside the window still blocks", () => {
  const row: LeaseRow = {
    owner: "other",
    heartbeatAt: new Date(NOW.getTime() - (LEASE_STALE_MS - 1000)),
  };
  assert.equal(canAcquire(row, "me", NOW), false);
});

test("canAcquire: a foreign owner past the staleness window is stealable", () => {
  const row: LeaseRow = {
    owner: "other",
    heartbeatAt: new Date(NOW.getTime() - (LEASE_STALE_MS + 1000)),
  };
  assert.equal(canAcquire(row, "me", NOW), true);
});

beforeEach(() => __resetLocalLeases());

test("in-process: first claimant wins, a second is denied, holder renews", async () => {
  assert.equal(await acquireLease("L", "a", NOW), true);
  assert.equal(await acquireLease("L", "b", NOW), false);
  assert.equal(await acquireLease("L", "a", NOW), true);
});

test("in-process: release frees the lease for the next claimant", async () => {
  assert.equal(await acquireLease("L", "a", NOW), true);
  await releaseLease("L", "a");
  assert.equal(await acquireLease("L", "b", NOW), true);
});

test("in-process: release by a non-holder is a no-op", async () => {
  assert.equal(await acquireLease("L", "a", NOW), true);
  await releaseLease("L", "b");
  assert.equal(await acquireLease("L", "b", NOW), false);
});

test("in-process: a stale lease is stolen by another owner", async () => {
  assert.equal(await acquireLease("L", "a", NOW), true);
  const later = new Date(NOW.getTime() + LEASE_STALE_MS + 60_000);
  assert.equal(await acquireLease("L", "b", later), true);
});

test("ownedByDeadLocalProcess: a dead pid on this host, and nothing else", () => {
  const probe = { host: "ia-main", alive: (pid: number) => pid === 100 };
  assert.equal(ownedByDeadLocalProcess("ia-main:200:abcd", probe), true);
  assert.equal(ownedByDeadLocalProcess("ia-main:100:abcd", probe), false);
  assert.equal(ownedByDeadLocalProcess("other:200:abcd", probe), false);
  assert.equal(ownedByDeadLocalProcess("4592-run_717dc455", probe), false);
  assert.equal(ownedByDeadLocalProcess("ia-main:notapid:x", probe), false);
});
