import { test } from "node:test";
import assert from "node:assert/strict";

import { isNewer, agentUpdateAvailable } from "./version";

test("isNewer: strict semver greater-than across each component", () => {
  assert.equal(isNewer("1.0.1", "1.0.0"), true);
  assert.equal(isNewer("1.1.0", "1.0.9"), true);
  assert.equal(isNewer("2.0.0", "1.9.9"), true);
  assert.equal(isNewer("1.0.0", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", "1.0.1"), false);
  assert.equal(isNewer("1.0.0", "2.0.0"), false);
});

test("isNewer: tolerates a leading v and trailing pre-release/build noise", () => {
  assert.equal(isNewer("v1.2.0", "1.1.0"), true);
  assert.equal(isNewer("1.2.0-rc.1", "1.1.0"), true);
  assert.equal(isNewer("dev", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", "dev"), false);
});

test("agentUpdateAvailable: only a host BEHIND the release gets the button", () => {
  assert.equal(agentUpdateAvailable("1.0.0", "1.1.0"), true);
  assert.equal(agentUpdateAvailable("1.1.0", "1.1.0"), false);
  assert.equal(agentUpdateAvailable("v1.1.0", "1.1.0"), false);
  assert.equal(agentUpdateAvailable("0.2.0", "0.1.0"), false);
  assert.equal(agentUpdateAvailable("1.31.0", "0.1.0"), false);
  assert.equal(agentUpdateAvailable("1.1.1", "1.1.0"), false);
});

test("agentUpdateAvailable: an uncomparable version keeps the repair path", () => {
  assert.equal(agentUpdateAvailable(null, "1.1.0"), true);
  assert.equal(agentUpdateAvailable("", "1.1.0"), true);
  assert.equal(agentUpdateAvailable("dev", "1.1.0"), true);
  assert.equal(agentUpdateAvailable("1.1.0", ""), true);
  assert.equal(agentUpdateAvailable("1.1.0", "dev"), true);
});
