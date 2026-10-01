import { test } from "node:test";
import assert from "node:assert/strict";

import { dbVolumeHostName, rerouteRequest } from "./stack";
import type { Database } from "../../types/database";
import { generateDatabaseCompose } from "../../deploy/database-compose";
import { composeStackVolumeHostNames } from "../project-backup-descriptor";

test("dbVolumeHostName matches the rendered DB compose volume (move copies the right volume)", () => {
  const slug = "db-mydb";
  assert.equal(dbVolumeHostName(slug), "deplo-db-mydb_db-mydb-data");

  const yaml = generateDatabaseCompose({
    network: "deplo-team-team_test",
    name: slug,
    databaseId: "db_test",
    type: "postgres",
    version: "16",
    username: "app",
    password: "pw",
    dbName: "db-mydb",
  });
  const derived = composeStackVolumeHostNames(slug, yaml);
  assert.deepEqual(derived, [dbVolumeHostName(slug)]);
});

test("a database reroute recreates the container, so a stopped one moves network too", () => {
  const db = {
    id: "db_1",
    teamId: "team_b",
    environmentId: null,
    host: "db-shop",
    mounts: [],
  } as unknown as Database;
  const req = rerouteRequest(db, "services: {}");
  assert.equal(req.network, "deplo-team-team_b");
  assert.deepEqual(req.composeUpArgs, ["--force-recreate"]);
});
