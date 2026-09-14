import { test } from "node:test";
import assert from "node:assert/strict";

import { composeJoinsForeignNetwork } from "./networks";

test("composeJoinsForeignNetwork: an external/pinned/host-bridged network join needs the grant", () => {
  const joins = (nets: string) =>
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks: [v]\n${nets}`,
    );
  assert.equal(
    joins(`networks:\n  v:\n    external: true\n    name: someone-elses-net`),
    true,
  );
  assert.equal(joins(`networks:\n  v:\n    name: someone-elses-net`), true);
  assert.equal(joins(`networks:\n  v:\n    external: true`), true);
  assert.equal(
    joins(`networks:\n  v:\n    external:\n      name: someone-elses-net`),
    true,
  );
  assert.equal(
    joins(
      `networks:\n  v:\n    driver: macvlan\n    driver_opts:\n      parent: eth0`,
    ),
    true,
  );
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks:\n      v: null\nnetworks:\n  v:\n    external: true\n    name: someone-elses-net`,
    ),
    true,
  );
});

test("composeJoinsForeignNetwork: an app's own network, and the shared one, stay free", () => {
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks: [internal]\nnetworks:\n  internal: {}`,
    ),
    false,
  );
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks: [deplo]\nnetworks:\n  deplo:\n    external: true`,
    ),
    false,
  );
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks: [sneaky]\nnetworks:\n  sneaky:\n    external: true\n    name: deplo`,
    ),
    false,
  );
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\nnetworks:\n  v:\n    external: true\n    name: someone-elses-net`,
    ),
    false,
  );
  assert.equal(
    composeJoinsForeignNetwork(`services:\n  a:\n    image: nginx`),
    false,
  );
});

test("composeJoinsForeignNetwork: a network Deplo mints is rewritten, not gated", () => {
  for (const name of [
    "deplo-env-environ_victim",
    "deplo-team-team_victim",
    "deplo-preview-shop__pr-1",
  ]) {
    assert.equal(
      composeJoinsForeignNetwork(
        `services:\n  a:\n    image: x\n    networks: [v]\nnetworks:\n  v:\n    external: true\n    name: ${name}`,
      ),
      false,
    );
    assert.equal(
      composeJoinsForeignNetwork(
        `services:\n  a:\n    image: x\nnetworks:\n  default:\n    external: true\n    name: ${name}`,
      ),
      false,
    );
  }
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\nnetworks:\n  default:\n    external: true\n    name: someone-elses-net`,
    ),
    true,
  );
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks: [v]\nnetworks:\n  v:\n    external: true\n    name: deplo-victim_default`,
    ),
    false,
  );
});
