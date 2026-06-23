import { test } from "node:test";
import assert from "node:assert/strict";

import { generateDatabaseCompose } from "./database-compose";
import type { DatabaseType } from "../types";

/**
 * The database compose is the on-host stack the agent provisions for a managed
 * database. Two properties are load-bearing for the backup/restore feature:
 *
 *  1. The named data volume MUST mount at the path the engine's image actually
 *     writes to — otherwise the data is NOT persisted (it lives in the
 *     container's ephemeral layer, lost on recreation) and a backup restore that
 *     writes to the engine's real data dir lands outside the volume. (Redis,
 *     mongodb and mariadb were previously mounted at the wrong path.)
 *  2. Every DB service has `restart: unless-stopped`, so the redis restore's
 *     `SHUTDOWN NOSAVE` is followed by a supervisor-driven reload of the
 *     restored RDB rather than leaving redis down.
 */

// The official images' documented data dirs — the volume must mount here.
const EXPECTED_DATA_DIR: Record<DatabaseType, string> = {
  postgres: "/var/lib/postgresql/data",
  mysql: "/var/lib/mysql",
  mariadb: "/var/lib/mysql",
  mongodb: "/data/db",
  redis: "/data",
  clickhouse: "/var/lib/clickhouse",
};

for (const type of Object.keys(EXPECTED_DATA_DIR) as DatabaseType[]) {
  test(`generateDatabaseCompose(${type}): data volume mounts at the engine's real data dir`, () => {
    const yaml = generateDatabaseCompose({
      name: "mydb",
      type,
      version: "1",
      password: "pw",
    });
    const dir = EXPECTED_DATA_DIR[type];
    assert.ok(
      yaml.includes(`- mydb-data:${dir}`),
      `expected the data volume to mount at ${dir}, got:\n${yaml}`,
    );
  });

  test(`generateDatabaseCompose(${type}): has restart: unless-stopped`, () => {
    const yaml = generateDatabaseCompose({
      name: "mydb",
      type,
      version: "1",
      password: "pw",
    });
    assert.ok(
      yaml.includes("restart: unless-stopped"),
      `every DB service must restart so a redis restore can reload after SHUTDOWN; got:\n${yaml}`,
    );
  });
}

test("generateDatabaseCompose: redis still sets requirepass via command override", () => {
  const yaml = generateDatabaseCompose({
    name: "cache",
    type: "redis",
    version: "7",
    password: "s3cret",
  });
  // The command override must not displace the corrected /data mount.
  assert.ok(yaml.includes("redis-server --requirepass s3cret"));
  assert.ok(yaml.includes("- cache-data:/data"));
});
