import { test } from "node:test";
import assert from "node:assert/strict";

import { databaseReach } from "./link";

const app = {
  teamId: "team_a",
  environmentId: "environ_1",
  serverId: "srv_1",
  clusterId: "clu_1",
};
const db = {
  ...app,
  serverId: "srv_2",
  exposedPublicly: false,
  exposedPort: null,
};

test("two members of one cluster reach each other by name inside an Environment", () => {
  assert.equal(databaseReach(app, db), "internal");
});

test("another cluster, or none, is still another server", () => {
  assert.equal(
    databaseReach(app, { ...db, clusterId: "clu_2" }),
    "other-server",
  );
  assert.equal(databaseReach(app, { ...db, clusterId: null }), "other-server");
  assert.equal(
    databaseReach({ ...app, clusterId: null }, { ...db, clusterId: null }),
    "other-server",
  );
  assert.equal(
    databaseReach({ ...app, clusterId: undefined }, db),
    "other-server",
  );
});

test("one cluster does not join two Environments or two teams", () => {
  assert.equal(
    databaseReach(app, { ...db, environmentId: "environ_2" }),
    "other-environment",
  );
  assert.equal(
    databaseReach(app, { ...db, teamId: "team_b", environmentId: null }),
    "other-team",
  );
  assert.equal(databaseReach(app, { ...db, teamId: "team_b" }), "other-team");
});
