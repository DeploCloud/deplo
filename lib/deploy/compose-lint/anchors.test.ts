import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeBuildReachesHost,
  composeNeedsHostPrivileges,
} from "./host-privileges";
import { composeHasHostBindMount } from "./volumes";

// Every gate fails open on YAML it cannot read, so a shape only the renderer parses is past all of them.
test("no host-escape gate is blind to a value that arrives through an anchor", () => {
  const via = (
    block: string,
    service = "    <<: *anchor\n    image: alpine\n",
  ) => `x-anchor: &anchor\n${block}services:\n  a:\n${service}`;

  assert.equal(
    composeNeedsHostPrivileges(via("  privileged: true\n")),
    true,
    "privileged",
  );
  assert.equal(
    composeNeedsHostPrivileges(
      `x-anchor: &anchor\n  !!merge <<: {}\n  privileged: true\nservices:\n  a:\n    <<: *anchor\n    image: alpine\n`,
    ),
    true,
    "privileged behind a TAGGED merge key",
  );
  assert.equal(
    composeNeedsHostPrivileges(via("  cap_add: [SYS_ADMIN]\n")),
    true,
    "cap_add",
  );
  assert.equal(composeNeedsHostPrivileges(via("  pid: host\n")), true, "pid");
  assert.equal(
    composeHasHostBindMount(via('  volumes: ["/:/host"]\n')),
    true,
    "bind mount",
  );
  assert.equal(
    composeBuildReachesHost(
      via("  build: {context: /}\n", "    <<: *anchor\n"),
    ),
    true,
    "build context",
  );
  assert.equal(
    composeNeedsHostPrivileges(via("  restart: always\n")),
    false,
    "a clean anchor",
  );
});
