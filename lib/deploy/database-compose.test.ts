import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateDatabaseCompose,
  buildConnectionString,
  parseConnectionPassword,
} from "./database-compose";
import type { DatabaseType } from "../types";

/** The username/dbName the pre-parameterization tests implicitly assumed: the
 *  service name for the DB, `app` for the login. Passed explicitly now that both
 *  are required params, keeping every existing assertion's expected value intact.
 *  `databaseId` stamps the deplo.* labels (required since the detail-page work). */
const DEFAULTS = { username: "app", dbName: "mydb", databaseId: "db_test" };

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
      ...DEFAULTS,
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
      ...DEFAULTS,
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
    databaseId: "db_test",
    type: "redis",
    version: "7",
    password: "s3cret",
    username: "default",
    dbName: "cache",
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
    const yaml = generateDatabaseCompose({ name: "mydb", type, version: "1", password: "pw", ...DEFAULTS });
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
    databaseId: "db_test",
    type: "postgres",
    version: "16",
    password: "pw",
    username: "app",
    dbName: "db-internal",
  });
  assert.ok(!yaml.includes("ports:"), `an unexposed DB must not publish a port; got:\n${yaml}`);
});

test("generateDatabaseCompose: publishes hostPort:enginePort bound to 0.0.0.0 when exposed", () => {
  // A postgres DB (engine port 5432) exposed on host port 25432.
  const yaml = generateDatabaseCompose({
    name: "db-public",
    databaseId: "db_test",
    type: "postgres",
    version: "16",
    password: "pw",
    username: "app",
    dbName: "db-public",
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
    databaseId: "db_test",
    type: "redis",
    version: "7",
    password: "pw",
    username: "default",
    dbName: "cache-public",
    hostPort: 26379,
  });
  assert.ok(
    yaml.includes(`- "0.0.0.0:26379:6379"`),
    `redis engine port 6379 must be the container side; got:\n${yaml}`,
  );
});

// The username/dbName are parameterized (create-only, applied at first init).
// They must reach the engine's real env vars, or a custom login/logical-DB the
// connection string advertises would not actually exist.
test("generateDatabaseCompose: threads a custom username + dbName into the engine env", () => {
  const yaml = generateDatabaseCompose({
    name: "db-shop",
    databaseId: "db_test",
    type: "postgres",
    version: "16",
    username: "shopuser",
    password: "pw",
    dbName: "shop",
  });
  assert.ok(yaml.includes("POSTGRES_USER=shopuser"), yaml);
  assert.ok(yaml.includes("POSTGRES_DB=shop"), yaml);
});

// mysql/mariadb: the image ALWAYS needs a root password and treats
// *_USER/*_PASSWORD as an OPTIONAL non-root user. With the default 'root'
// username we must emit ONLY the root password + database (no MYSQL_USER — the
// image rejects MYSQL_USER=root), so the connection string's root login is real.
for (const [type, prefix] of [
  ["mysql", "MYSQL"],
  ["mariadb", "MARIADB"],
] as const) {
  test(`generateDatabaseCompose(${type}): root username emits no ${prefix}_USER`, () => {
    const yaml = generateDatabaseCompose({
      name: "db-app",
      databaseId: "db_test",
      type,
      version: "1",
      username: "root",
      password: "pw",
      dbName: "app",
    });
    assert.ok(yaml.includes(`${prefix}_ROOT_PASSWORD=pw`), yaml);
    assert.ok(yaml.includes(`${prefix}_DATABASE=app`), yaml);
    assert.ok(!yaml.includes(`${prefix}_USER=`), `must not emit ${prefix}_USER for root; got:\n${yaml}`);
  });

  // A non-root username creates the extra scoped user ALONGSIDE root (root is
  // still needed for backups, which dump as root). Both share the one password.
  test(`generateDatabaseCompose(${type}): non-root username emits ${prefix}_USER alongside root`, () => {
    const yaml = generateDatabaseCompose({
      name: "db-app",
      databaseId: "db_test",
      type,
      version: "1",
      username: "appuser",
      password: "pw",
      dbName: "app",
    });
    assert.ok(yaml.includes(`${prefix}_ROOT_PASSWORD=pw`), yaml);
    assert.ok(yaml.includes(`${prefix}_USER=appuser`), yaml);
    assert.ok(yaml.includes(`${prefix}_PASSWORD=pw`), yaml);
  });
}

// buildConnectionString is the single source of truth for the string's shape,
// shared by create + edit. Verify the per-engine scheme, path segment and the
// two engine-specific quirks (mongo authSource, mariadb->mysql scheme).
test("buildConnectionString: per-engine scheme + path", () => {
  const base = { username: "app", password: "pw", host: "db-x", port: 5432 };
  assert.equal(
    buildConnectionString({ ...base, type: "postgres", dbName: "shop" }),
    "postgres://app:pw@db-x:5432/shop",
  );
  // mariadb keeps the mysql:// scheme (the wire protocol is mysql's).
  assert.equal(
    buildConnectionString({ ...base, type: "mariadb", dbName: "shop" }),
    "mysql://app:pw@db-x:5432/shop",
  );
  // mongo's root user lives in `admin`, so authSource=admin is mandatory.
  assert.equal(
    buildConnectionString({ ...base, type: "mongodb", dbName: "shop" }),
    "mongodb://app:pw@db-x:5432/shop?authSource=admin",
  );
  // redis has no logical DB — no path segment.
  assert.equal(
    buildConnectionString({ ...base, type: "redis", username: "default", dbName: "ignored" }),
    "redis://default:pw@db-x:5432",
  );
});

// The deplo.* labels are LOAD-BEARING: the agent authorizes every container RPC
// (listInstances/exec/attach/followLogs) by `deplo.project=<id>`, so a DB stack
// without them is invisible to logs, the terminal, and the runtime poll.
test("generateDatabaseCompose: stamps the deplo.* labels with the database id", () => {
  const yaml = generateDatabaseCompose({
    name: "mydb",
    type: "postgres",
    version: "16",
    password: "pw",
    ...DEFAULTS,
  });
  assert.ok(yaml.includes("labels:"), yaml);
  assert.ok(yaml.includes("- deplo.managed=true"), yaml);
  assert.ok(yaml.includes("- deplo.project=db_test"), yaml);
  assert.ok(yaml.includes("- deplo.slug=mydb"), yaml);
});

// Resource limits render as the same compose keys apps use; absent limits render
// NOTHING (no resource keys at all), preserving the no-limits stack unchanged.
test("generateDatabaseCompose: renders resource limits, omits them when unset", () => {
  const base = {
    name: "mydb",
    type: "postgres" as DatabaseType,
    version: "16",
    password: "pw",
    ...DEFAULTS,
  };
  const plain = generateDatabaseCompose(base);
  assert.ok(!plain.includes("mem_limit"), plain);
  assert.ok(!plain.includes("cpus:"), plain);

  const limited = generateDatabaseCompose({
    ...base,
    resources: {
      memoryMb: 512,
      memoryReservationMb: null,
      swapMb: null,
      cpuMilli: 500,
      cpuShares: null,
      cpuset: null,
      pidsLimit: 256,
      shmSizeMb: null,
      storageGb: null,
      nofile: null,
      nproc: null,
      oomScoreAdj: null,
    },
  });
  assert.ok(limited.includes("mem_limit: 512m"), limited);
  assert.ok(limited.includes("cpus: '0.5'"), limited);
  assert.ok(limited.includes("pids_limit: 256"), limited);
});

// customImage replaces the derived engine image ref entirely (version inert).
test("generateDatabaseCompose: customImage replaces the derived image", () => {
  const yaml = generateDatabaseCompose({
    name: "mydb",
    type: "postgres",
    version: "16",
    password: "pw",
    ...DEFAULTS,
    customImage: "timescale/timescaledb:2.15-pg16",
  });
  assert.ok(yaml.includes("image: timescale/timescaledb:2.15-pg16"), yaml);
  assert.ok(!yaml.includes("postgres:16-alpine"), yaml);
});

// customCommand replaces the default verbatim — including redis's
// password-bearing `--requirepass` (the UI warns; this is the expert hatch).
test("generateDatabaseCompose: customCommand replaces redis's requirepass command", () => {
  const yaml = generateDatabaseCompose({
    name: "cache",
    databaseId: "db_test",
    type: "redis",
    version: "7",
    password: "s3cret",
    username: "default",
    dbName: "cache",
    customCommand: "redis-server /etc/redis/redis.conf",
  });
  assert.ok(yaml.includes("command: redis-server /etc/redis/redis.conf"), yaml);
  assert.ok(!yaml.includes("--requirepass"), yaml);
});

// Real per-engine healthchecks (replacing the historical `exit 0`), chosen to
// avoid embedding the password literally. Under a customImage override the
// engine tooling can't be assumed — fall back to the no-op probe.
test("generateDatabaseCompose: real healthcheck per engine, exit 0 under customImage", () => {
  const mk = (type: DatabaseType, extra: Record<string, unknown> = {}) =>
    generateDatabaseCompose({
      name: "mydb",
      type,
      version: "1",
      password: "pw",
      ...DEFAULTS,
      ...extra,
    });
  assert.ok(mk("postgres").includes("pg_isready -U app -d mydb"));
  assert.ok(
    mk("mysql").includes(
      'mysqladmin ping -h 127.0.0.1 -uroot -p\\"$$MYSQL_ROOT_PASSWORD\\"',
    ),
  );
  assert.ok(mk("mariadb").includes("healthcheck.sh --connect --innodb_initialized"));
  assert.ok(mk("mongodb").includes("db.adminCommand('ping').ok"));
  assert.ok(mk("redis").includes('"CMD-SHELL", "redis-cli ping"'));
  assert.ok(mk("clickhouse").includes("http://127.0.0.1:8123/ping"));
  for (const yaml of [mk("postgres"), mk("redis")])
    assert.ok(!yaml.includes('"exit 0"'), yaml);
  const custom = mk("postgres", { customImage: "myorg/pg:1" });
  assert.ok(custom.includes('"CMD-SHELL", "exit 0"'), custom);
});

// parseConnectionPassword recovers the create-only password on edit (and for the
// backup dump). It must round-trip whatever buildConnectionString embeds.
test("parseConnectionPassword: round-trips the embedded password", () => {
  for (const type of ["postgres", "mongodb", "mariadb", "redis"] as const) {
    const conn = buildConnectionString({
      type,
      username: "u",
      password: "p4ss-w0rd_.~",
      host: "h",
      port: 1,
      dbName: "d",
    });
    assert.equal(parseConnectionPassword(conn), "p4ss-w0rd_.~", conn);
  }
  assert.equal(parseConnectionPassword("not a url"), "");
});
