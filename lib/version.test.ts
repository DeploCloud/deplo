import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXPECTED_AGENT_VERSION,
  isNewer,
  isAgentOutdated,
} from "./version";

test("isNewer: strict semver greater-than across each component", () => {
  assert.equal(isNewer("1.0.1", "1.0.0"), true);
  assert.equal(isNewer("1.1.0", "1.0.9"), true);
  assert.equal(isNewer("2.0.0", "1.9.9"), true);
  // equal is not newer
  assert.equal(isNewer("1.0.0", "1.0.0"), false);
  // older is not newer
  assert.equal(isNewer("1.0.0", "1.0.1"), false);
  assert.equal(isNewer("1.0.0", "2.0.0"), false);
});

test("isNewer: tolerates a leading v and trailing pre-release/build noise", () => {
  assert.equal(isNewer("v1.2.0", "1.1.0"), true);
  assert.equal(isNewer("1.2.0-rc.1", "1.1.0"), true);
  // unparseable on either side => not newer (never a false positive)
  assert.equal(isNewer("dev", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", "dev"), false);
});

test("isAgentOutdated: flags only a version provably behind the expected one", () => {
  // a server one patch behind the control plane is outdated
  assert.equal(isAgentOutdated("0.9.9"), isNewer(EXPECTED_AGENT_VERSION, "0.9.9"));
  // the expected version itself is current
  assert.equal(isAgentOutdated(EXPECTED_AGENT_VERSION), false);
});

test("isAgentOutdated: never flags what it can't compare", () => {
  // not-yet-seen agent
  assert.equal(isAgentOutdated(null), false);
  assert.equal(isAgentOutdated(undefined), false);
  assert.equal(isAgentOutdated(""), false);
  // a dev/non-semver build is left alone rather than wrongly flagged
  assert.equal(isAgentOutdated("dev"), false);
  // a server somehow AHEAD of us is not "outdated"
  assert.equal(isAgentOutdated("99.0.0"), false);
});

test("isAgentOutdated: compares against an explicit expected version when given", () => {
  // The async path resolves "expected" from the latest GitHub release and passes
  // it in, rather than relying on the static fallback.
  assert.equal(isAgentOutdated("1.0.0", "1.2.0"), true);
  assert.equal(isAgentOutdated("1.2.0", "1.2.0"), false);
  assert.equal(isAgentOutdated("1.3.0", "1.2.0"), false); // ahead of expected
  // still never flags what it can't compare, regardless of expected
  assert.equal(isAgentOutdated(null, "9.9.9"), false);
  assert.equal(isAgentOutdated("dev", "9.9.9"), false);
});
