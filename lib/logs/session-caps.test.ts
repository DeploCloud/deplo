import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { AttachHandle } from "../infra/docker";
import { open, destroy, __allSessionIdsForTest } from "./session";

const handle = (): AttachHandle => ({
  onData: () => () => {},
  onExit: () => {},
  write: () => {},
  close: () => {},
});

afterEach(() => {
  for (const id of __allSessionIdsForTest()) destroy(id);
});

// Regression: a ceiling must evict only the caller's OWN streams, never close other people's consoles.
test("the per-app cap and the global cap only ever evict the same user's sessions", () => {
  const mine: string[] = [];
  for (const user of ["user_a", "user_b", "user_c", "user_d"])
    for (let app = 0; app < 4; app++)
      for (let i = 0; i < 4; i++) {
        const id = open(`app_${app}`, user, "c", handle()).id;
        if (user === "user_a") mine.push(id);
      }
  assert.equal(__allSessionIdsForTest().length, 64);

  assert.throws(
    () => open("app_9", "user_e", "c", handle()),
    /Too many live sessions/,
  );
  assert.equal(__allSessionIdsForTest().length, 64);
  for (const id of mine) assert.ok(__allSessionIdsForTest().includes(id));

  const fresh = open("app_0", "user_a", "c", handle());
  const left = __allSessionIdsForTest();
  assert.equal(left.length, 64);
  assert.ok(left.includes(fresh.id));
  assert.ok(!left.includes(mine[0]));
});

test("one person holds at most 16 live sessions, whatever the apps", () => {
  for (let app = 0; app < 4; app++)
    for (let i = 0; i < 4; i++) open(`app_${app}`, "user_a", "c", handle());
  assert.equal(__allSessionIdsForTest().length, 16);
  const seventeenth = open("app_9", "user_a", "c", handle());
  const ids = __allSessionIdsForTest();
  assert.equal(ids.length, 16, "the oldest of A's own made room");
  assert.ok(ids.includes(seventeenth.id));
});
