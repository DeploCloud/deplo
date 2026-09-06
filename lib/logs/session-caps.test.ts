import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { AttachHandle } from "../infra/docker";
import { open, destroy, __allSessionIdsForTest } from "./session";

/**
 * The live-session ceilings evict only the caller's OWN streams: a cap reached by
 * other people's consoles is a refusal, never a way to close theirs.
 */

const handle = (): AttachHandle => ({
  onData: () => () => {},
  onExit: () => {},
  write: () => {},
  close: () => {},
});

afterEach(() => {
  for (const id of __allSessionIdsForTest()) destroy(id);
});

test("the per-app cap and the global cap only ever evict the same user's sessions", () => {
  // User A fills the instance: 8 apps × 8 streams = the global ceiling.
  const mine: string[] = [];
  for (let app = 0; app < 8; app++)
    for (let i = 0; i < 8; i++)
      mine.push(open(`app_${app}`, "user_a", "c", handle()).id);
  assert.equal(__allSessionIdsForTest().length, 64);

  // User B is refused rather than evicting one of A's.
  assert.throws(
    () => open("app_9", "user_b", "c", handle()),
    /Too many live sessions/,
  );
  assert.equal(__allSessionIdsForTest().length, 64);
  for (const id of mine) assert.ok(__allSessionIdsForTest().includes(id));

  // A's next stream evicts A's oldest, and only that.
  const fresh = open("app_0", "user_a", "c", handle());
  const left = __allSessionIdsForTest();
  assert.equal(left.length, 64);
  assert.ok(left.includes(fresh.id));
  assert.ok(!left.includes(mine[0]));
});
