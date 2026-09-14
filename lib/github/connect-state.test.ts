import { test } from "node:test";
import assert from "node:assert/strict";

import { readConnectState, signConnectState } from "./manifest";

// The connect state is the CSRF proof that THIS user started the flow, plus the address to hand the browser back to.
test("connect state round-trips the return path for its own user only", () => {
  const withReturn = signConnectState("usr_1", "/new?template=ghost");
  assert.deepEqual(readConnectState(withReturn, "usr_1"), {
    returnTo: "/new?template=ghost",
  });
  // Another account replaying it gets nothing, not a redirect.
  assert.equal(readConnectState(withReturn, "usr_2"), null);

  // A flow started with no return address is still valid - it just ends on Settings → Git.
  const bare = signConnectState("usr_1");
  assert.deepEqual(readConnectState(bare, "usr_1"), { returnTo: null });

  // `usr_1` must not match `usr_10`: the payload separator is what keeps a prefix id apart.
  assert.equal(
    readConnectState(signConnectState("usr_10", "/new"), "usr_1"),
    null,
  );

  // Junk, missing and tampered states are all "no state".
  assert.equal(readConnectState(null, "usr_1"), null);
  assert.equal(readConnectState("not-a-state", "usr_1"), null);
  assert.equal(readConnectState(`${withReturn}x`, "usr_1"), null);
});

test("connect state refuses an off-site return address at both ends", () => {
  // Dropped when minted, so nothing off-site is ever signed…
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
