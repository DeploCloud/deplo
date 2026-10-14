import { test } from "node:test";
import assert from "node:assert/strict";

import { encryptSecret } from "../../crypto";
import { renderDatabaseStackYaml } from "../databases/stack";
import type { Database } from "../../types/database";
import { databaseDescriptor } from "./target-descriptor";

process.env.DEPLO_SECRET ??= "test-secret-for-target-descriptor-aaaa";

// The agent refuses a backup or restore whose container does not carry this label value.
test("databaseDescriptor: project_id is the label the database stack puts on its container", () => {
  const db = {
    id: "db_1",
    host: "db-orders",
    type: "postgres",
    version: "17",
    username: "app",
    dbName: "orders",
    exposedPublicly: false,
    exposedPort: null,
    resources: null,
    customImage: null,
    customCommand: null,
    mounts: [],
    connectionStringEnc: encryptSecret(
      "postgres://app:pw@db-orders:5432/orders",
    ),
  } as unknown as Database;
  const d = databaseDescriptor(db);
  assert.equal(d.projectId, "db_1");
  assert.equal(d.container, "db-orders");
  assert.match(renderDatabaseStackYaml(db, "pw"), /deplo\.project=db_1\b/);
});
