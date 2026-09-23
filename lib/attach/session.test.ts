import { test } from "node:test";
import assert from "node:assert/strict";

import type { AttachHandle } from "../infra/docker";
import { open, destroyForApp } from "./session";

const handle = (): AttachHandle => ({
  onData: () => () => {},
  onExit: () => {},
  write: () => {},
  close: () => {},
});

test("a refused console session closes the stream and the connection it was handed", () => {
  for (const user of ["user_a", "user_b", "user_c", "user_d"])
    for (let app = 0; app < 4; app++)
      for (let i = 0; i < 4; i++)
        open(`app_${app}`, "team", user, "c", handle());

  let closed = 0;
  let cleaned = 0;
  const refused = { ...handle(), close: () => void closed++ };
  try {
    assert.throws(
      () => open("app_9", "team", "user_e", "c", refused, () => void cleaned++),
      /Too many live sessions/,
    );
    assert.equal(closed, 1);
    assert.equal(cleaned, 1);
  } finally {
    for (let app = 0; app < 4; app++) destroyForApp(`app_${app}`);
  }
});
