import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { deplo } from "../package.json";

import {
  AGENT_MIN_VERSION,
  AGENT_VERSION,
  CLUSTER_MIN_VERSION,
  CLUSTER_VERSION,
  clusterPinned,
  versionAtLeast,
  agentReach,
  agentUpdateAvailable,
  agentUsable,
  bareVersion,
  DEPLO_VERSION,
  isNewer,
  isPrerelease,
  newestVersion,
  rankedCurrent,
  REQUIRED_STOP,
  versionTag,
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

test("a version reads the same with or without its tag's v", () => {
  assert.equal(versionTag("0.6.0"), "v0.6.0");
  assert.equal(versionTag(" V0.6.0-canary.3 "), "v0.6.0-canary.3");
  assert.equal(bareVersion("v0.6.0"), "0.6.0");
  assert.equal(bareVersion("0.6.0"), "0.6.0");
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

test("a server that never connected waits for its link, whatever version it last told Deplo", () => {
  const agent = (version: string) => ({ agent: { version } });
  const LINKED = { firstLinkedAt: "2026-10-29T00:00:00.000Z" };
  const LEFT = { leftBehindAt: "2026-10-28T00:00:00.000Z" };
  // Enrolled, but its link has not come: a proxy or a firewall, never an update.
  assert.equal(agentReach(agent(""), "0.5.1"), "unlinked");
  assert.equal(agentReach(agent("0.5.1-canary.10"), "0.5.1"), "unlinked");
  assert.equal(agentReach(agent("0.5.1"), "0.5.1"), "unlinked");
  // Left behind on an agent that can link: it comes back once it connects.
  assert.equal(agentReach({ ...agent("0.5.1"), ...LEFT }, "0.5.1"), "unlinked");
  // Left behind on a version Deplo never read, or too old to link: only a reinstall.
  assert.equal(agentReach({ ...agent(""), ...LEFT }, "0.5.1"), "reinstall");
  assert.equal(agentReach(agent("0.4.0"), "0.5.1"), "reinstall");
  assert.equal(agentReach({ ...agent("0.4.0"), ...LINKED }), "reinstall");
  // Linked once: its version alone decides.
  assert.equal(agentReach({ ...agent("0.5.1"), ...LINKED }, "0.5.1"), "usable");
  assert.equal(
    agentReach({ ...agent("0.5.1-canary.10"), ...LINKED }, "0.5.1"),
    "updatable",
  );
  assert.equal(agentReach({ ...agent(""), ...LINKED }, "0.5.1"), "updatable");
});

test("the pin is usable by its own floor", () => {
  assert.ok(agentUsable(AGENT_VERSION));
  assert.ok(!isNewer(AGENT_MIN_VERSION, AGENT_VERSION));
});

// ADR-0041: a stop is a stable release before any stable release requires it. The tag workflow checks it is published,
// which also refuses the stop itself: the two versions match only between the merge and the next version bump.
test("this release only requires an earlier stop, and a stable one when it is stable itself", () => {
  const stop = REQUIRED_STOP;
  if (!stop) return;
  assert.ok(!isNewer(stop, DEPLO_VERSION), `v${stop} comes after this release`);
  if (!isPrerelease(DEPLO_VERSION))
    assert.ok(
      !isPrerelease(stop),
      `stable v${DEPLO_VERSION} requires v${stop}`,
    );
});

// Nothing dials a server since v0.6.0, the stop every server linked by (ADR-0041): below it, an instance reaches none.
test("every release requires the stop that brought every server onto its link", () => {
  assert.ok(REQUIRED_STOP, "requiresStop is empty");
  assert.ok(
    !isNewer("0.6.0", REQUIRED_STOP),
    `v${REQUIRED_STOP} comes before the stop every server linked by`,
  );
});

// The floor only moves up: a release that fixes a security flaw raises it to itself.
test("the security floor names a release no later than this one", () => {
  const floor = deplo.securityFloor;
  assert.ok(floor, "deplo.securityFloor is empty");
  assert.ok(
    !isNewer(floor, DEPLO_VERSION),
    `v${floor} comes after this release`,
  );
});

// An empty pin is the one explicit "unpinned" state, and only with an empty floor.
test("the cluster pin is unset, or set with a floor it satisfies", () => {
  if (!CLUSTER_VERSION) {
    assert.equal(CLUSTER_MIN_VERSION, "", "a floor without a pin");
    assert.equal(clusterPinned(), false);
    return;
  }
  assert.equal(clusterPinned(), true);
  assert.ok(versionAtLeast(CLUSTER_VERSION, CLUSTER_MIN_VERSION || "0.0.0"));
  assert.ok(!isNewer(CLUSTER_MIN_VERSION, CLUSTER_VERSION));
});

test("only a parseable version is a cluster pin", () => {
  assert.equal(clusterPinned(""), false);
  assert.equal(clusterPinned("dev"), false);
  assert.equal(clusterPinned("v0.1.0"), true);
});

// The tag workflow is the guard that a pin names a published release (ADR-0037).
test("the tag workflow refuses a cluster pin with no published checksums.txt", () => {
  const yml = readFileSync(
    join(import.meta.dirname, "..", ".github", "workflows", "docker-image.yml"),
    "utf8",
  );
  assert.match(yml, /deplo\.cluster/);
  assert.match(
    yml,
    /DeploCloud\/deplo-cluster\/releases\/download\/v\$\{pin\}\/checksums\.txt/,
  );
  assert.match(yml, /deplo\.cluster is unset/);
});
