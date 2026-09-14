import { test } from "node:test";
import assert from "node:assert/strict";

import { dbVolumeHostName } from "./stack";
import { generateDatabaseCompose } from "../../deploy/database-compose";
import { composeStackVolumeHostNames } from "../project-backup-descriptor";

// dbVolumeHostName must equal what the rendered DB compose actually produces, or a move
// would export/import the wrong (non-existent) volume and silently migrate nothing.
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
