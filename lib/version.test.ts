import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_MIN_VERSION,
  AGENT_VERSION,
  agentUpdateAvailable,
  agentUsable,
  isNewer,
  isPrerelease,
  newestVersion,
  rankedCurrent,
} from "./version";

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

test("isNewer: a canary sorts before its release and by its own number", () => {
  assert.equal(isNewer("0.3.0", "0.3.0-canary.2"), true);
  assert.equal(isNewer("0.3.0-canary.2", "0.3.0"), false);
  assert.equal(isNewer("0.3.0-canary.2", "0.3.0-canary.1"), true);
  assert.equal(isNewer("0.3.0-canary.10", "0.3.0-canary.9"), true);
  assert.equal(isNewer("0.3.0-canary.1", "0.2.0"), true);
  assert.equal(isNewer("0.2.1", "0.3.0-canary.1"), false);
  assert.equal(isNewer("0.3.0-canary.1", "0.3.0-canary.1"), false);
});

test("isPrerelease and newestVersion", () => {
  assert.equal(isPrerelease("v0.3.0-canary.1"), true);
  assert.equal(isPrerelease("0.3.0"), false);
  assert.equal(isPrerelease("dev"), false);
  assert.equal(
    newestVersion(
      ["v0.2.0", "v0.3.0-canary.2", "junk", "v0.3.0-canary.10", "v0.2.9"],
      (v) => v,
    ),
    "v0.3.0-canary.10",
  );
  assert.equal(
    newestVersion([], (v: string) => v),
    null,
  );
});

test("a git-describe dev build reads as its tag, never as a canary of it", () => {
  assert.equal(isNewer("0.2.0", "0.2.0-8-gb39f8a7"), false);
  assert.equal(isPrerelease("0.2.0-8-gb39f8a7"), false);
  assert.equal(agentUpdateAvailable("0.2.0-8-gb39f8a7", "0.2.0"), false);
  assert.equal(agentUpdateAvailable("0.2.0-8-gb39f8a7", "0.2.1"), true);
});

test("a withdrawn stable ranks below its own canaries, and its re-release is an update", () => {
  const feed = ["v0.5.0-canary.10", "v0.4.0", "v0.3.0"];
  const current = rankedCurrent("0.5.0", feed);
  assert.equal(isNewer("v0.5.0-canary.10", current), true);
  assert.equal(isNewer("v0.5.0", current), true);
  assert.equal(isNewer("v0.4.0", current), false);
});

test("a listed stable and any canary compare as themselves", () => {
  assert.equal(rankedCurrent("0.4.0", ["v0.5.0-canary.10", "v0.4.0"]), "0.4.0");
  assert.equal(rankedCurrent("0.5.0-canary.9", ["v0.4.0"]), "0.5.0-canary.9");
  assert.equal(rankedCurrent("dev", ["v0.4.0"]), "dev");
});

test("agentUsable: the floor is inclusive, newer is fine, unparseable is not", () => {
  assert.equal(agentUsable("0.4.0", "0.4.0"), true);
  assert.equal(agentUsable("0.4.3", "0.4.0"), true);
  assert.equal(agentUsable("0.6.0-canary.1", "0.4.0"), true);
  assert.equal(agentUsable("0.3.9", "0.4.0"), false);
  assert.equal(agentUsable("0.4.0-canary.9", "0.4.0"), false);
  assert.equal(agentUsable("v0.4.0-8-gb39f8a7", "0.4.0"), true);
  assert.equal(agentUsable("", "0.4.0"), false);
  assert.equal(agentUsable(null, "0.4.0"), false);
  assert.equal(agentUsable("dev", "0.4.0"), false);
});

test("the pin is usable by its own floor", () => {
  assert.ok(agentUsable(AGENT_VERSION));
  assert.ok(!isNewer(AGENT_MIN_VERSION, AGENT_VERSION));
});
