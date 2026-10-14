import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { AttachHandle } from "../infra/docker";
import { open, get, recheckAccess, destroy } from "./session";

const handle = (): AttachHandle => ({
  onData: () => () => {},
  onExit: () => {},
  write: () => {},
  close: () => {},
});

const opened: string[] = [];
const openAs = (
  kind: "app" | "database",
  appId: string,
  userId: string,
  h = handle(),
  cleanup?: () => void,
  authorize = async () => true,
) => {
  const s = open(
    { kind, appId, teamId: "team", userId, authorize },
    "c",
    h,
    cleanup,
  );
  opened.push(s.id);
  return s;
};

afterEach(() => {
  for (const id of opened.splice(0)) destroy(id);
});

test("a refused console session closes the stream and the connection it was handed", () => {
  for (const user of ["user_a", "user_b"])
    for (let app = 0; app < 4; app++)
      for (let i = 0; i < 4; i++) openAs("app", `app_${app}`, user);

  let closed = 0;
  let cleaned = 0;
  const refused = { ...handle(), close: () => void closed++ };
  assert.throws(
    () => openAs("app", "app_9", "user_e", refused, () => void cleaned++),
    /too many live sessions/,
  );
  assert.equal(closed, 1);
  assert.equal(cleaned, 1);
});

test("an app console is not reachable as a database console, nor the reverse", () => {
  const app = openAs("app", "shared_id", "user_a");
  const db = openAs("database", "shared_db", "user_a");
  assert.equal(get(app.id, "shared_id", "database"), undefined);
  assert.equal(get(db.id, "shared_db", "app"), undefined);
  assert.equal(get(app.id, "shared_id", "app"), app);
  assert.equal(get(db.id, "shared_db", "database"), db);
});

test("a console whose user lost access is closed on the next check", async () => {
  const kept = openAs("app", "app_0", "user_a");
  const lost = openAs("app", "app_1", "user_b", handle(), undefined, async () =>
    Promise.resolve(false),
  );
  let exited = 0;
  lost.onExit = () => void exited++;

  await recheckAccess();
  assert.equal(exited, 1);
  assert.equal(get(lost.id, "app_1", "app"), undefined);
  assert.equal(get(kept.id, "app_0", "app"), kept);
});
