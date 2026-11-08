import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { OVERLAP_CAPABILITY, deployOverlap } from "./overlap";

const ready = {
  ports: [],
  capabilities: [OVERLAP_CAPABILITY],
  dockerVersion: "27.3.1",
};

describe("overlap or in-place", () => {
  test("an app with no ports on a current server keeps its old version online", () => {
    assert.deepEqual(deployOverlap(ready), { overlap: true });
  });

  test("an app that opens ports on the server swaps in place, and says why", () => {
    const d = deployOverlap({
      ...ready,
      ports: [
        { id: "prt_1", published: 25565, target: 25565, protocol: "tcp" },
      ],
    });
    assert.equal(d.overlap, false);
    assert.match(d.overlap ? "" : d.reason, /ports on the server/);
  });

  test("an agent without the capability swaps in place, and says why", () => {
    const d = deployOverlap({ ...ready, capabilities: ["deploy.ready-check"] });
    assert.equal(d.overlap, false);
    assert.match(d.overlap ? "" : d.reason, /agent is too old/);
  });

  // Without start_interval the probe would run every second for the app's whole life.
  test("Docker older than 25 swaps in place, and says why", () => {
    for (const dockerVersion of ["24.0.7", "", undefined]) {
      const d = deployOverlap({ ...ready, dockerVersion });
      assert.equal(d.overlap, false, String(dockerVersion));
      assert.match(d.overlap ? "" : d.reason, /Docker/);
    }
  });
});
