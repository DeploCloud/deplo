import { test } from "node:test";
import assert from "node:assert/strict";

import { archivesChangeLog } from "./change-log";

const pg = {
  type: "postgres" as const,
  clusterId: "clu_1",
  customImage: null,
  customCommand: null,
};

test("archivesChangeLog: a Postgres database on a cluster does", () => {
  assert.equal(archivesChangeLog(pg), true);
  assert.equal(
    archivesChangeLog({ ...pg, customImage: "postgres:17-bookworm" }),
    true,
  );
});

test("archivesChangeLog: not off a cluster, not another engine, not somebody else's image or command", () => {
  assert.equal(archivesChangeLog({ ...pg, clusterId: null }), false);
  assert.equal(archivesChangeLog({ ...pg, type: "mysql" }), false);
  assert.equal(archivesChangeLog({ ...pg, type: "mariadb" }), false);
  assert.equal(
    archivesChangeLog({ ...pg, customImage: "timescale/timescaledb:pg17" }),
    false,
  );
  assert.equal(
    archivesChangeLog({ ...pg, customCommand: "postgres -c fsync=off" }),
    false,
  );
});
