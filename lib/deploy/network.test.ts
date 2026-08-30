import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appNetwork,
  deployNetwork,
  explainNetworkError,
  isTenantNetwork,
  previewNetwork,
  PLATFORM_NETWORKS,
} from "./network";

test("an Environment owns the network; without one the team does", () => {
  assert.equal(
    appNetwork({ environmentId: "environ_a", teamId: "team_x" }),
    "deplo-env-environ_a",
  );
  assert.equal(
    appNetwork({ environmentId: null, teamId: "team_x" }),
    "deplo-team-team_x",
  );
  // A folder never reaches this function, so it cannot change the answer.
  assert.equal(
    appNetwork({ teamId: "team_x" }),
    appNetwork({ environmentId: null, teamId: "team_x" }),
  );
});

test("two placements never collide, and a preview stands alone", () => {
  const names = new Set([
    appNetwork({ environmentId: "environ_a", teamId: "team_x" }),
    appNetwork({ environmentId: "environ_b", teamId: "team_x" }),
    appNetwork({ environmentId: null, teamId: "team_x" }),
    appNetwork({ environmentId: null, teamId: "team_y" }),
    previewNetwork("shop__pr-42"),
  ]);
  assert.equal(names.size, 5);
});

test("a preview deploy is sealed off; production follows the placement", () => {
  const app = { environmentId: "environ_a", teamId: "team_x" };
  assert.equal(deployNetwork(app), "deplo-env-environ_a");
  assert.equal(deployNetwork(app, null), "deplo-env-environ_a");
  assert.equal(deployNetwork(app, "shop__pr-7"), "deplo-preview-shop__pr-7");
});

test("a platform network is never a tenant one", () => {
  for (const n of PLATFORM_NETWORKS) assert.equal(isTenantNetwork(n), false);
  for (const n of [
    "deplo-env-environ_a",
    "deplo-team-team_x",
    "deplo-preview-shop__pr-1",
  ])
    assert.equal(isTenantNetwork(n), true);
  // Not ours at all.
  assert.equal(isTenantNetwork("bridge"), false);
  assert.equal(isTenantNetwork("deplo-something-else"), false);
});

test("an exhausted address pool is explained, everything else is passed through", () => {
  const raw =
    "could not find an available, non-overlapping IPv4 address pool: all predefined address pools have been fully subnetted";
  const out = explainNetworkError(raw);
  assert.ok(out.startsWith(raw));
  assert.match(out, /daemon\.json/);
  assert.equal(explainNetworkError("no such image"), "no such image");
});
