import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateDatabaseCompose,
  buildConnectionString,
  parseConnectionPassword,
} from "./database-compose";
import type { DatabaseType } from "../types/database";

const DEFAULTS = {
  username: "app",
  dbName: "mydb",
  databaseId: "db_test",
  network: "deplo-team-team_test",
};

const CURRENT_VERSION: Record<DatabaseType, string> = {
  postgres: "18",
  mysql: "8.4",
  mariadb: "11",
  mongodb: "8",
  redis: "8",
  clickhouse: "25.8",
};

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
      version: CURRENT_VERSION[type],
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
    network: "deplo-team-team_test",
    name: "cache",
    databaseId: "db_test",
    type: "redis",
    version: "7",
    password: "s3cret",
    username: "default",
    dbName: "cache",
  });
  assert.ok(yaml.includes("redis-server --requirepass s3cret"));
  assert.ok(yaml.includes("- cache-data:/data"));
});

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
    const yaml = generateDatabaseCompose({
      name: "mydb",
      type,
      version: "1",
      password: "pw",
      ...DEFAULTS,
    });
    assert.ok(
      yaml.includes(envLine),
      `${type} must create the db-name database the backup descriptor dumps; got:\n${yaml}`,
    );
  });
}

test("generateDatabaseCompose: no ports block when hostPort omitted (internal only)", () => {
  const yaml = generateDatabaseCompose({
    network: "deplo-team-team_test",
    name: "db-internal",
    databaseId: "db_test",
    type: "postgres",
    version: "16",
    password: "pw",
    username: "app",
    dbName: "db-internal",
  });
  assert.ok(
    !yaml.includes("ports:"),
    `an unexposed DB must not publish a port; got:\n${yaml}`,
  );
});

test("generateDatabaseCompose: publishes hostPort:enginePort bound to 0.0.0.0 when exposed", () => {
  const yaml = generateDatabaseCompose({
    network: "deplo-team-team_test",
    name: "db-public",
    databaseId: "db_test",
    type: "postgres",
    version: "16",
    password: "pw",
    username: "app",
    dbName: "db-public",
    hostPort: 25432,
  });
  assert.ok(
    yaml.includes("ports:"),
    `an exposed DB must publish a port; got:\n${yaml}`,
  );
  assert.ok(
    yaml.includes(`- "0.0.0.0:25432:5432"`),
    `expected host:container mapping 0.0.0.0:25432:5432, got:\n${yaml}`,
  );
});

test("generateDatabaseCompose: hostPort maps to the engine's own port (redis 6379)", () => {
  const yaml = generateDatabaseCompose({
    network: "deplo-team-team_test",
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

test("generateDatabaseCompose: threads a custom username + dbName into the engine env", () => {
  const yaml = generateDatabaseCompose({
    network: "deplo-team-team_test",
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

for (const [type, prefix] of [
  ["mysql", "MYSQL"],
  ["mariadb", "MARIADB"],
] as const) {
  test(`generateDatabaseCompose(${type}): root username emits no ${prefix}_USER`, () => {
    const yaml = generateDatabaseCompose({
      network: "deplo-team-team_test",
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
    assert.ok(
      !yaml.includes(`${prefix}_USER=`),
      `must not emit ${prefix}_USER for root; got:\n${yaml}`,
    );
  });

  test(`generateDatabaseCompose(${type}): non-root username emits ${prefix}_USER alongside root`, () => {
    const yaml = generateDatabaseCompose({
      network: "deplo-team-team_test",
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

test("buildConnectionString: per-engine scheme + path", () => {
  const base = { username: "app", password: "pw", host: "db-x", port: 5432 };
  assert.equal(
    buildConnectionString({ ...base, type: "postgres", dbName: "shop" }),
    "postgres://app:pw@db-x:5432/shop",
  );
  assert.equal(
    buildConnectionString({ ...base, type: "mariadb", dbName: "shop" }),
    "mysql://app:pw@db-x:5432/shop",
  );
  assert.equal(
    buildConnectionString({ ...base, type: "mongodb", dbName: "shop" }),
    "mongodb://app:pw@db-x:5432/shop?authSource=admin",
  );
  assert.equal(
    buildConnectionString({
      ...base,
      type: "redis",
      username: "default",
      dbName: "ignored",
    }),
    "redis://default:pw@db-x:5432",
  );
});

test("buildConnectionString: the credential survives every URL delimiter", () => {
  const password = "p@ss/w:o?r#d%2Fx[]";
  const username = "we@ird user";
  const conn = buildConnectionString({
    type: "postgres",
    username,
    password,
    host: "db-x",
    port: 5432,
    dbName: "shop",
  });

  assert.equal(parseConnectionPassword(conn), password);
  const url = new URL(conn);
  assert.equal(decodeURIComponent(url.username), username);
  assert.equal(url.hostname, "db-x");
  assert.equal(url.pathname, "/shop");
  assert.equal(url.port, "5432");
});

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

test("generateDatabaseCompose: customCommand replaces redis's requirepass command", () => {
  const yaml = generateDatabaseCompose({
    network: "deplo-team-team_test",
    name: "cache",
    databaseId: "db_test",
    type: "redis",
    version: "7",
    password: "s3cret",
    username: "default",
    dbName: "cache",
    customCommand: "redis-server /etc/redis/redis.conf",
  });
  assert.ok(
    yaml.includes('command: "redis-server /etc/redis/redis.conf"'),
    yaml,
  );
  assert.ok(!yaml.includes("--requirepass"), yaml);
});

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
  assert.ok(
    mk("mariadb").includes("healthcheck.sh --connect --innodb_initialized"),
  );
  assert.ok(mk("mongodb").includes("db.adminCommand('ping').ok"));
  assert.ok(mk("redis").includes('"CMD-SHELL", "redis-cli ping"'));
  assert.ok(mk("clickhouse").includes("http://127.0.0.1:8123/ping"));
  for (const yaml of [mk("postgres"), mk("redis")])
    assert.ok(!yaml.includes('"exit 0"'), yaml);
  const custom = mk("postgres", { customImage: "myorg/pg:1" });
  assert.ok(custom.includes('"CMD-SHELL", "exit 0"'), custom);
});

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

for (const version of ["15", "16", "17", "18", "19"]) {
  test(`generateDatabaseCompose(postgres ${version}): pins PGDATA to the mounted path`, () => {
    const yaml = generateDatabaseCompose({
      name: "mydb",
      type: "postgres",
      version,
      password: "pw",
      ...DEFAULTS,
    });
    assert.ok(
      yaml.includes("- PGDATA=/var/lib/postgresql/data"),
      `expected PGDATA pinned to the mount, got:\n${yaml}`,
    );
  });
}

test("generateDatabaseCompose: an official customImage keeps the real healthcheck", () => {
  const yaml = generateDatabaseCompose({
    name: "mydb",
    type: "postgres",
    version: "18",
    password: "pw",
    ...DEFAULTS,
    customImage: "postgres:18",
  });
  assert.ok(yaml.includes("image: postgres:18\n"), yaml);
  assert.ok(yaml.includes("pg_isready"), yaml);
  assert.ok(!yaml.includes("exit 0"), yaml);
});

test("generateDatabaseCompose: a foreign customImage still degrades the healthcheck", () => {
  const yaml = generateDatabaseCompose({
    name: "mydb",
    type: "postgres",
    version: "16",
    password: "pw",
    ...DEFAULTS,
    customImage: "timescale/timescaledb:2.15-pg16",
  });
  assert.ok(yaml.includes("exit 0"), yaml);
  assert.ok(!yaml.includes("pg_isready"), yaml);
});

test("generateDatabaseCompose: a config file is bound under the data volume", () => {
  const yaml = generateDatabaseCompose({
    name: "mydb",
    type: "postgres",
    version: "16",
    password: "pw",
    ...DEFAULTS,
    filesDir: "/data/stacks/files/db-mydb",
    mounts: [
      { filePath: "postgresql.conf", mountPath: "/etc/postgresql.conf" },
      { filePath: "conf.d/tuning.conf", mountPath: "/etc/conf.d/tuning.conf" },
    ],
  });
  assert.match(yaml, /\n {6}- mydb-data:\/var\/lib\/postgresql\/data\n/);
  assert.ok(
    yaml.includes(
      '- "/data/stacks/files/db-mydb/postgresql.conf:/etc/postgresql.conf"',
    ),
    yaml,
  );
  assert.ok(
    yaml.includes(
      '- "/data/stacks/files/db-mydb/conf.d/tuning.conf:/etc/conf.d/tuning.conf"',
    ),
    yaml,
  );
});

test("generateDatabaseCompose: no config files renders exactly what it always did", () => {
  const base = {
    name: "mydb",
    type: "postgres" as const,
    version: "16",
    password: "pw",
    ...DEFAULTS,
  };
  assert.equal(
    generateDatabaseCompose({
      ...base,
      mounts: [],
      filesDir: "/data/stacks/files/db-mydb",
    }),
    generateDatabaseCompose(base),
  );
});

test("generateDatabaseCompose: redis carries REDISCLI_AUTH so redis-cli inside authenticates", () => {
  const input = {
    network: "deplo-team-team_test",
    name: "cache",
    databaseId: "db_test",
    type: "redis" as const,
    version: "7",
    password: "s3cret",
    username: "default",
    dbName: "cache",
  };
  assert.ok(generateDatabaseCompose(input).includes("REDISCLI_AUTH=s3cret"));
  const custom = generateDatabaseCompose({
    ...input,
    customCommand: "redis-server --appendonly yes",
  });
  assert.ok(!custom.includes("REDISCLI_AUTH"), custom);
});
