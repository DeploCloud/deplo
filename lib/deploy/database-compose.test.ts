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

// The logical database the backup descriptor dumps (dbName == db.host == the
// compose `name`) MUST be created at provision time, or a backup silently dumps
// a database that doesn't exist. Postgres/mysql/mariadb/clickhouse create it via
// an env var; mongo creates it lazily on first write; redis has no logical DB.
const DB_CREATE_ENV: Partial<Record<DatabaseType, string>> = {
  postgres: "POSTGRES_DB=mydb",
  mysql: "MYSQL_DATABASE=mydb",
  mariadb: "MARIADB_DATABASE=mydb",
  clickhouse: "CLICKHOUSE_DB=mydb",
};
for (const [type, envLine] of Object.entries(DB_CREATE_ENV) as [
  DatabaseType,
  string,
][]) {
  test(`generateDatabaseCompose(${type}): creates the logical database via ${envLine.split("=")[0]}`, () => {
    const yaml = generateDatabaseCompose({ name: "mydb", type, version: "1", password: "pw" });
    assert.ok(
      yaml.includes(envLine),
      `${type} must create the db-name database the backup descriptor dumps; got:\n${yaml}`,
    );
  });
}

// "Expose publicly": when a host port is given, the compose publishes it as
// `0.0.0.0:<hostPort>:<enginePort>` (host:container) so external clients reach the
// DB on the chosen host port — the whole point of the feature. When no host port
// is given the DB has NO `ports:` block (internal deplo-network access only).
test("generateDatabaseCompose: no ports block when hostPort omitted (internal only)", () => {
  const yaml = generateDatabaseCompose({
    name: "db-internal",
    type: "postgres",
    version: "16",
    password: "pw",
  });
  assert.ok(!yaml.includes("ports:"), `an unexposed DB must not publish a port; got:\n${yaml}`);
});

test("generateDatabaseCompose: publishes hostPort:enginePort bound to 0.0.0.0 when exposed", () => {
  // A postgres DB (engine port 5432) exposed on host port 25432.
  const yaml = generateDatabaseCompose({
    name: "db-public",
    type: "postgres",
    version: "16",
    password: "pw",
    hostPort: 25432,
  });
  assert.ok(yaml.includes("ports:"), `an exposed DB must publish a port; got:\n${yaml}`);
  assert.ok(
    yaml.includes(`- "0.0.0.0:25432:5432"`),
    `expected host:container mapping 0.0.0.0:25432:5432, got:\n${yaml}`,
  );
});

test("generateDatabaseCompose: hostPort maps to the engine's own port (redis 6379)", () => {
  const yaml = generateDatabaseCompose({
    name: "cache-public",
    type: "redis",
    version: "7",
    password: "pw",
    hostPort: 26379,
  });
  assert.ok(
    yaml.includes(`- "0.0.0.0:26379:6379"`),
    `redis engine port 6379 must be the container side; got:\n${yaml}`,
  );
});
