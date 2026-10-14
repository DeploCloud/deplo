import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { AttachHandle } from "../infra/docker";
import {
  open as openSession,
  destroy,
  subscribe,
  recheckAccess,
  MAX_BACKLOG_BYTES,
  __allSessionIdsForTest,
} from "./session";

const handle = (): AttachHandle => ({
  onData: () => () => {},
  onExit: () => {},
  write: () => {},
  close: () => {},
});

const open = (
  appId: string,
  userId: string,
  h = handle(),
  cleanup?: () => void,
  teamId = `team_of_${userId}`,
  authorize = async () => true,
) => openSession({ appId, teamId, userId, authorize }, "c", h, cleanup);

// n sessions for one user, spread over four apps so the per-app cap never bites.
function fill(userId: string, teamId: string, n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) =>
      open(`app_${userId}_${i % 4}`, userId, handle(), undefined, teamId).id,
  );
}

afterEach(() => {
  for (const id of __allSessionIdsForTest()) destroy(id);
});

test("a full Deplo makes room from the team holding the most, never refuses a newcomer", () => {
  const first = fill("user_a", "team_a", 16)[0];
  for (const u of ["user_b", "user_c", "user_d"]) fill(u, `team_${u}`, 16);
  assert.equal(__allSessionIdsForTest().length, 64);

  const fresh = open("app_9", "user_e");
  const ids = __allSessionIdsForTest();
  assert.equal(ids.length, 64);
  assert.ok(ids.includes(fresh.id));
  assert.ok(!ids.includes(first), "the heaviest team's oldest made room");
});

test("a full Deplo takes the caller's own oldest session first", () => {
  const mine = fill("user_a", "team_a", 8);
  for (const u of ["user_b", "user_c", "user_d"]) fill(u, `team_${u}`, 16);
  fill("user_e", "team_e", 8);
  assert.equal(__allSessionIdsForTest().length, 64);

  const fresh = open("app_user_a_0", "user_a", handle(), undefined, "team_a");
  const left = __allSessionIdsForTest();
  assert.equal(left.length, 64);
  assert.ok(left.includes(fresh.id));
  assert.ok(!left.includes(mine[0]));
  for (const id of mine.slice(1)) assert.ok(left.includes(id));
});

test("a team holds at most 32, and a teammate with none open is told why", () => {
  fill("user_a", "team_a", 16);
  fill("user_b", "team_a", 16);
  assert.throws(
    () => open("app_9", "user_c", handle(), undefined, "team_a"),
    /Your team has too many live sessions open/,
  );
  assert.equal(__allSessionIdsForTest().length, 32);
});

test("the store refuses only a team already holding as much as any other", () => {
  fill("user_a", "team_1", 16);
  fill("user_b", "team_1", 4);
  fill("user_c", "team_2", 16);
  fill("user_d", "team_2", 4);
  fill("user_e", "team_3", 16);
  fill("user_f", "team_3", 4);
  fill("user_g", "team_4", 4);
  assert.equal(__allSessionIdsForTest().length, 64);
  assert.throws(
    () => open("app_9", "user_h", handle(), undefined, "team_1"),
    /Too many live sessions on this Deplo/,
  );
});

test("one person holds at most 16 live sessions, whatever the apps", () => {
  fill("user_a", "team_a", 16);
  const seventeenth = open("app_9", "user_a", handle(), undefined, "team_a");
  const ids = __allSessionIdsForTest();
  assert.equal(ids.length, 16, "the oldest of A's own made room");
  assert.ok(ids.includes(seventeenth.id));
});

test("a refused session closes the stream and the connection it was handed", () => {
  fill("user_a", "team_a", 16);
  fill("user_b", "team_a", 16);

  let closed = 0;
  let cleaned = 0;
  const refused = { ...handle(), close: () => void closed++ };
  assert.throws(
    () => open("app_9", "user_e", refused, () => void cleaned++, "team_a"),
    /too many live sessions/,
  );
  assert.equal(closed, 1);
  assert.equal(cleaned, 1);
});

test("a session whose viewer lost access ends with the reason", async () => {
  let allowed = true;
  const kept = open("app_0", "user_a");
  const s = open("app_1", "user_b", handle(), undefined, "team_b", async () =>
    Promise.resolve(allowed),
  );
  const exits: (string | undefined)[] = [];
  s.onExit = (error) => exits.push(error);

  await recheckAccess();
  assert.ok(__allSessionIdsForTest().includes(s.id));

  allowed = false;
  await recheckAccess();
  assert.deepEqual(exits, ["forbidden"]);
  assert.deepEqual(__allSessionIdsForTest(), [kept.id]);
});

test("output buffered before anyone subscribes is capped by bytes", () => {
  let push: (chunk: Buffer) => void = () => {};
  const s = open("app_0", "user_a", {
    ...handle(),
    onData: (cb) => {
      push = cb;
      return () => {};
    },
  });
  const chunk = Buffer.alloc(64 * 1024, 1);
  for (let i = 0; i < 64; i++) push(chunk);

  const got: Buffer[] = [];
  subscribe(s, (c) => got.push(c));
  const bytes = got.reduce((n, c) => n + c.length, 0);
  assert.ok(bytes <= MAX_BACKLOG_BYTES && bytes > 0, `${bytes} bytes`);
});
