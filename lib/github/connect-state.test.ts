import { test } from "node:test";
import assert from "node:assert/strict";

import { readConnectState, signConnectState } from "./manifest";

test("connect state round-trips the return path for its own user only", () => {
  const withReturn = signConnectState("usr_1", "/new?template=ghost");
  assert.deepEqual(readConnectState(withReturn, "usr_1"), {
    returnTo: "/new?template=ghost",
  });
  assert.equal(readConnectState(withReturn, "usr_2"), null);

  const bare = signConnectState("usr_1");
  assert.deepEqual(readConnectState(bare, "usr_1"), { returnTo: null });

  assert.equal(
    readConnectState(signConnectState("usr_10", "/new"), "usr_1"),
    null,
  );

  assert.equal(readConnectState(null, "usr_1"), null);
  assert.equal(readConnectState("not-a-state", "usr_1"), null);
  assert.equal(readConnectState(`${withReturn}x`, "usr_1"), null);
});

test("connect state refuses an off-site return address at both ends", () => {
  assert.deepEqual(
    readConnectState(signConnectState("usr_1", "//evil.example.com"), "usr_1"),
    {
      returnTo: null,
    },
  );
  assert.deepEqual(
    readConnectState(
      signConnectState("usr_1", "https://evil.example.com"),
      "usr_1",
    ),
    {
      returnTo: null,
    },
  );
});
