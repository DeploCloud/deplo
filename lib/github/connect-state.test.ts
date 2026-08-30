// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import { readConnectState, signConnectState } from "./manifest";

/**
 * The connect state is both halves of the GitHub round trip: the CSRF proof that
 * the flow was started by THIS user, and the address to hand the browser back to
 * afterwards.
 */
test("connect state round-trips the return path for its own user only", () => {
  const withReturn = signConnectState("usr_1", "/new?template=ghost");
  assert.deepEqual(readConnectState(withReturn, "usr_1"), {
    returnTo: "/new?template=ghost",
  });
  // Another account replaying it gets nothing, not a redirect.
  assert.equal(readConnectState(withReturn, "usr_2"), null);

  // A flow started with no return address is still valid - it just ends where
  // it always did, on Settings → Git.
  const bare = signConnectState("usr_1");
  assert.deepEqual(readConnectState(bare, "usr_1"), { returnTo: null });

  // A user id that is a prefix of another must not match: `usr_1` is not
  // `usr_10`, and the payload separator is what keeps them apart.
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
