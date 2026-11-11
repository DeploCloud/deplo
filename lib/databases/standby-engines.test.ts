import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

import {
  DB_DATA_DIRS,
  generateDatabaseCompose,
} from "../deploy/database-compose";
import type { DatabaseType } from "../types/database";
import { STANDBY_ENGINES } from "./standby";
import { marks } from "./standby-shell";

// No engine runs here: the scripts are read as text, parsed by a shell, and run against stand-ins of the engines'
// tools inside a throwaway folder. What only a real engine can show is listed for ticket #220.

const args = {
  host: "db-main",
  username: "app",
  dbName: "shop",
  password: "pw-123_ABC",
};
const PORT: Record<string, number> = {
  mysql: 3306,
  mariadb: 3306,
  redis: 6379,
  mongodb: 27017,
};
const NEW = ["mysql", "mariadb", "redis", "mongodb"] as const;
type New = (typeof NEW)[number];

const row = (type: New) => STANDBY_ENGINES[type]!;
const startOf = (type: New, seed = "sby_1") =>
  row(type).start({
    ...args,
    port: PORT[type],
    primaryHost: "db-main",
    seed,
  });

/** The copy's service as compose hands it to the engine: every `$$` is one dollar again. */
function copyService(type: New) {
  const yaml = generateDatabaseCompose({
    name: "db-main",
    databaseId: "db_1",
    type,
    version: "99",
    username: "app",
    password: "enginepw",
    dbName: "shop",
    hostPort: 25000,
    network: "deplo-env-e1",
    mongoKeyfile: type === "mongodb" ? "a2V5" : null,
    standby: startOf(type),
  });
  const doc = parse(yaml) as {
    services: Record<
      string,
      {
        container_name: string;
        command: string[];
        environment: string[];
        ports?: string[];
        volumes: string[];
      }
    >;
  };
  return doc.services;
}

for (const type of NEW)
  test(`${type}: the copy's stack never answers to the database's name, keeps its volume and publishes nothing`, () => {
    const services = copyService(type);
    assert.deepEqual(Object.keys(services), ["db-main_standby"]);
    const svc = services["db-main_standby"];
    assert.equal(svc.container_name, "db-main_standby");
    assert.equal(svc.ports, undefined);
    assert.deepEqual(svc.volumes, [`db-main-data:${DB_DATA_DIRS[type]}`]);
    assert.ok(svc.environment.includes("DEPLO_STANDBY_SEED=sby_1"));
    assert.deepEqual(svc.command.slice(0, 2), ["sh", "-c"]);
    assert.doesNotMatch(svc.command[2], /(^|[^$])\$([^$]|$)/);
    const script = svc.command[2].replaceAll("$$", "$");
    assert.equal(script, startOf(type).command[2]);
    // The wipe is behind the seed check: data this copy seeded, or was promoted on, is never deleted.
    const wipe = script.indexOf(
      `find ${DB_DATA_DIRS[type]} -mindepth 1 -delete`,
    );
    assert.ok(wipe > 0, "the copy starts from an empty folder");
    assert.ok(script.indexOf('!= "$DEPLO_STANDBY_SEED"') < wipe);
  });

test("the login a copy follows with is made by Deplo, may not write, and is not the database's own", () => {
  for (const type of ["mysql", "mariadb"] as const) {
    const script = row(type).prepare({ ...args, port: 3306 });
    assert.ok(
      script.includes(
        `CREATE USER IF NOT EXISTS '\\''deplo_standby'\\''@'\\''%'\\'' IDENTIFIED BY '\\''pw-123_ABC'\\''`,
      ),
      type,
    );
    assert.match(script, /REPLICATION SLAVE, REPLICATION CLIENT ON \*\.\* TO/);
    assert.doesNotMatch(script, /ALL PRIVILEGES|INSERT|UPDATE|DELETE|SUPER/);
    // A database whose binary log was turned off says so instead of making a copy that follows nothing.
    assert.match(script, /SELECT @@log_bin/);
    assert.match(
      row(type).retire({ ...args, port: 3306 }),
      /DROP USER IF EXISTS/,
    );
  }
  const redis = row("redis").prepare({ ...args, port: 6379 });
  assert.match(
    redis,
    /ACL SETUSER deplo_standby reset on '>pw-123_ABC' \+psync \+replconf \+ping\n/,
  );
  assert.match(
    row("redis").retire({ ...args, port: 6379 }),
    /ACL DELUSER deplo_standby/,
  );
  const copy = startOf("redis").command[2];
  assert.match(
    copy,
    /--masteruser deplo_standby --masterauth "\$DEPLO_STANDBY_PASSWORD"/,
  );
  assert.ok(startOf("redis").env.includes("DEPLO_STANDBY_PASSWORD=pw-123_ABC"));
  // MongoDB's members know each other by the set's keyfile, which Deplo derives: no second secret travels.
  assert.deepEqual(startOf("mongodb").env, ["DEPLO_STANDBY_SEED=sby_1"]);
  assert.match(startOf("mongodb").command[2], /--keyFile \/etc\/mongo-keyfile/);
});

test("a MongoDB copy joins as a member that never votes, and leaves the set when the copy goes", () => {
  const join = row("mongodb").prepare({ ...args, port: 27017 });
  assert.match(join, /host: h, priority: 0, votes: 0, hidden: true/);
  assert.match(join, /const h = "db-main_standby:27017"/);
  // One database and one copy, whatever a failover left behind.
  assert.match(join, /c\.members = \[me, \{/);
  const leave = row("mongodb").retire({ ...args, port: 27017 });
  assert.match(leave, /c\.members\.filter\(\(x\) => x\.host !== h\)/);
});

test("a Redis copy persists like its database, so the restart after a promotion loses nothing more", () => {
  assert.match(
    startOf("redis").command[2],
    /redis-server --requirepass "\$REDISCLI_AUTH" --appendonly yes --appendfsync everysec --replicaof db-main 6379 /,
  );
});

test("a MariaDB database writes its binary log only while it keeps a copy, and the other engines start as before", () => {
  const compose = (type: DatabaseType, keepsStandby: boolean) =>
    (
      parse(
        generateDatabaseCompose({
          name: "db-main",
          databaseId: "db_1",
          type,
          version: "99",
          username: "app",
          password: "enginepw",
          dbName: "shop",
          network: "deplo-env-e1",
          keepsStandby,
        }),
      ) as { services: Record<string, { command?: string[] }> }
    ).services["db-main"].command;
  assert.deepEqual(compose("mariadb", true), [
    "--log-bin=deplo-binlog",
    "--server-id=1",
    "--binlog-expire-logs-seconds=3600",
    "--max-binlog-total-size=1073741824",
  ]);
  assert.equal(compose("mariadb", false), undefined);
  for (const type of ["postgres", "mysql", "redis", "mongodb"] as const)
    assert.deepEqual(compose(type, true), compose(type, false), type);
});

for (const type of NEW)
  test(`${type}: a promotion is refused by the copy itself when it had stopped following, before anything else runs`, () => {
    const { user, command } = row(type).promote;
    assert.equal(user, "");
    assert.deepEqual(command.slice(0, 2), ["sh", "-c"]);
    const script = command[2];
    assert.ok(script.startsWith(marks(DB_DATA_DIRS[type]).refuse));
    const step = {
      mysql: "RESET REPLICA ALL",
      mariadb: "RESET REPLICA ALL",
      redis: "REPLICAOF NO ONE",
      mongodb: null,
    }[type];
    if (step) assert.ok(script.indexOf("exit 1") < script.indexOf(step));
    // The copy never promotes itself: its own start command holds no promotion.
    if (step) assert.ok(!startOf(type).command[2].includes(step));
    assert.equal(row(type).check, marks(DB_DATA_DIRS[type]).check);
  });

// --- the scripts, run for real against stand-ins ---

interface Box {
  root: string;
  data: string;
  log: () => string[];
  tool: (name: string, body?: string) => void;
  run: (
    script: string,
    env?: Record<string, string>,
    shell?: string,
  ) => { code: number; stderr: string; stdout: string };
}

/** A throwaway folder standing in for the container: its data folder, and tools that only write down how they were called. */
function box(t: { after: (fn: () => void) => void }): Box {
  const root = mkdtempSync(join(tmpdir(), "deplo-sbx-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data");
  mkdirSync(data);
  mkdirSync(join(root, "bin"));
  const tool = (name: string, body = "") => {
    const file = join(root, "bin", name);
    writeFileSync(
      file,
      `#!/bin/sh\necho "${name} $*" >> "${root}/log"\n${body}\n`,
    );
    chmodSync(file, 0o755);
  };
  // The background loop ends at once instead of outliving the test.
  writeFileSync(join(root, "bin", "sleep"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(root, "bin", "sleep"), 0o755);
  tool("docker-entrypoint.sh");
  tool("chown");
  tool("chmod");
  /** Every path of the container is moved under the folder; a script that still names one outside it does not run. */
  const moved = (script: string) => {
    const out = script
      .replaceAll("/tmp/deplo-standby", join(root, "tmp-deplo-standby"))
      .replaceAll("/var/lib/mysql", data)
      .replaceAll("/data/db", data)
      .replaceAll("/docker-entrypoint-initdb.d", join(root, "initdb.d"))
      .replaceAll("/etc/mongo-keyfile", join(root, "keyfile"))
      .replace(/(^|[\s"=])\/data\b/g, `$1${data}`);
    assert.doesNotMatch(
      out.replaceAll(root, "@BOX"),
      /(^|[\s"'=>])\/(var|etc|data|docker-entrypoint|tmp|usr|opt|root|home)\b/,
      "the script names a path outside the folder",
    );
    return out;
  };
  return {
    root,
    data,
    tool,
    log: () =>
      existsSync(join(root, "log"))
        ? readFileSync(join(root, "log"), "utf8").trim().split("\n")
        : [],
    run: (script, env = {}, shell = "sh") => {
      const res = spawnSync(shell, ["-c", moved(script)], {
        env: {
          NODE_ENV: "test",
          PATH: `${join(root, "bin")}:/usr/bin:/bin`,
          BOX: root,
          ...env,
        },
        encoding: "utf8",
        timeout: 20_000,
      });
      return {
        code: res.status ?? -1,
        stderr: res.stderr,
        stdout: res.stdout,
      };
    },
  };
}

const minutesAgo = (file: string, minutes: number) => {
  const at = new Date(Date.now() - minutes * 60_000);
  utimesSync(file, at, at);
};

test("the copy's check tells following from waiting, seeding and behind, and only a copy that followed lately may be promoted", (t) => {
  const b = box(t);
  const m = marks("/data");
  const state = (seed: string) =>
    b.run(m.check, { DEPLO_STANDBY_SEED: seed }).stdout.trim();
  const promotable = () => b.run(m.refuse, { DEPLO_STANDBY_SEED: "sby_1" });

  assert.equal(state("sby_1"), "seeding");
  assert.equal(promotable().code, 1);
  writeFileSync(join(b.data, "deplo-standby-seed"), "sby_1");
  // Seeded and never seen following: no better than a copy that stopped.
  assert.equal(state("sby_1"), "behind");
  writeFileSync(join(b.data, "deplo-standby-following"), "");
  assert.equal(state("sby_1"), "following");
  assert.equal(promotable().code, 0);
  minutesAgo(join(b.data, "deplo-standby-following"), 5);
  assert.equal(state("sby_1"), "waiting");
  assert.equal(promotable().code, 0);
  minutesAgo(join(b.data, "deplo-standby-following"), 16);
  assert.equal(state("sby_1"), "behind");
  const refused = promotable();
  assert.equal(refused.code, 1);
  assert.equal(
    refused.stderr.trim(),
    "the standby copy had not followed its database for 15 minutes",
  );
  // Data another seed left here is not this copy's.
  assert.equal(state("sby_2"), "seeding");
});

for (const type of NEW)
  test(`${type}: the copy starts over only when its data came from another seed, and ends as the engine following its database`, (t) => {
    const b = box(t);
    b.tool("redis-cli");
    b.tool(
      "mongosh",
      'case "$*" in *--host*) echo \'{"_id":"rs0","version":{"$numberInt":"2"}}\';; *27018*) echo "conf=$DEPLO_STANDBY_CONF" >> "$BOX/log";; esac',
    );
    b.tool(
      "mongod",
      'case "$*" in *--fork*) touch "$BOX/data/WiredTiger";; esac',
    );
    const env = {
      DEPLO_STANDBY_SEED: "sby_1",
      DEPLO_STANDBY_PASSWORD: "pw-123_ABC",
      REDISCLI_AUTH: "enginepw",
      MONGO_KEYFILE: "a2V5",
      MONGO_INITDB_ROOT_USERNAME: "app",
      MONGO_INITDB_ROOT_PASSWORD: "enginepw",
    };
    const script = startOf(type).command[2];
    writeFileSync(join(b.data, "left-by-an-old-database"), "x");

    const first = b.run(script, env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(existsSync(join(b.data, "left-by-an-old-database")), false);
    // Not seeded yet: that is said only once the copy has all of its database.
    assert.equal(existsSync(join(b.data, "deplo-standby-seed")), false);
    const started = b.log().at(-1)!;
    const expected = {
      mysql:
        "docker-entrypoint.sh mysqld --server-id=2 --relay-log=deplo-relay",
      mariadb:
        "docker-entrypoint.sh mariadbd --server-id=2 --relay-log=deplo-relay",
      redis:
        "docker-entrypoint.sh redis-server --requirepass enginepw --appendonly yes --appendfsync everysec --replicaof db-main 6379 --masteruser deplo_standby --masterauth pw-123_ABC",
      mongodb: `docker-entrypoint.sh mongod --replSet rs0 --keyFile ${b.root}/keyfile --bind_ip_all`,
    }[type];
    assert.equal(started, expected);
    if (type === "mongodb") {
      assert.equal(readFileSync(join(b.root, "keyfile"), "utf8"), "a2V5");
      // The set's configuration is read from the database and put into the empty copy before it starts as a member.
      const calls = b.log().filter((l) => /^(mongod|mongosh|conf=)/.test(l));
      assert.match(
        calls[0],
        /^mongosh --quiet --host db-main --port 27017 -u app -p enginepw /,
      );
      assert.match(
        calls[1],
        /^mongod --dbpath .* --bind_ip 127\.0\.0\.1 --port 27018 --fork /,
      );
      assert.match(calls[2], /^mongosh --quiet --port 27018 --eval /);
      assert.equal(calls[3], 'conf={"_id":"rs0","version":{"$numberInt":"2"}}');
      assert.match(calls[4], /^mongod --dbpath .* --shutdown$/);
    }

    // The same seed again (the container restarted): what is there stays.
    writeFileSync(join(b.data, "deplo-standby-seed"), "sby_1");
    writeFileSync(join(b.data, "its-data"), "x");
    assert.equal(b.run(script, env).code, 0);
    assert.equal(existsSync(join(b.data, "its-data")), true);
    assert.equal(b.log().at(-1), expected);

    // A new seed: Deplo asked for a copy of the database as it is now.
    assert.equal(
      b.run(script, { ...env, DEPLO_STANDBY_SEED: "sby_2" }).code,
      0,
    );
    assert.equal(existsSync(join(b.data, "its-data")), false);
  });

const DUMPS = {
  mysql: {
    tool: "mysqldump",
    head: "-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='binlog.000003', SOURCE_LOG_POS=157;",
    follow:
      "CHANGE REPLICATION SOURCE TO SOURCE_HOST='db-main', SOURCE_PORT=3306, SOURCE_USER='deplo_standby', SOURCE_PASSWORD='pw-123_ABC', SOURCE_LOG_FILE='binlog.000003', SOURCE_LOG_POS=157, GET_SOURCE_PUBLIC_KEY=1;",
    called:
      "mysqldump --get-server-public-key --source-data=2 --set-gtid-purged=OFF --host=db-main --port=3306 --user=deplo_standby --all-databases --single-transaction --routines --events --triggers",
  },
  mariadb: {
    tool: "mariadb-dump",
    head: "-- CHANGE MASTER TO MASTER_LOG_FILE='deplo-binlog.000001', MASTER_LOG_POS=343;",
    follow:
      "CHANGE MASTER TO MASTER_HOST='db-main', MASTER_PORT=3306, MASTER_USER='deplo_standby', MASTER_PASSWORD='pw-123_ABC', MASTER_LOG_FILE='deplo-binlog.000001', MASTER_LOG_POS=343, MASTER_USE_GTID=no;",
    called:
      "mariadb-dump --master-data=2 --host=db-main --port=3306 --user=deplo_standby --all-databases --single-transaction --routines --events --triggers",
  },
} as const;

/** Runs what the copy leaves for the image's entrypoint, the way the entrypoint does: sourced by bash, errors fatal. */
function seedSql(
  b: Box,
  type: "mysql" | "mariadb",
  dump: string,
  emptyEngine: () => void = () => {},
) {
  const env = {
    DEPLO_STANDBY_SEED: "sby_1",
    DEPLO_STANDBY_PASSWORD: "pw-123_ABC",
  };
  assert.equal(b.run(startOf(type).command[2], env).code, 0);
  emptyEngine();
  const init = join(b.root, "initdb.d", "deplo-standby.sh");
  execFileSync("bash", ["-n", init]);
  writeFileSync(join(b.root, "dump.sql"), dump);
  b.tool(
    DUMPS[type].tool,
    'echo "password=$MYSQL_PWD" >> "$BOX/log"; cat "$BOX/dump.sql"',
  );
  return b.run(
    `set -eo pipefail; docker_process_sql() { cat >> "$BOX/sql"; }; . "${init}"`,
    env,
    "bash",
  );
}

for (const type of ["mysql", "mariadb"] as const)
  test(`${type}: the copy is seeded from a dump, follows from the very place the dump was taken, and only then counts as seeded`, (t) => {
    const b = box(t);
    const d = DUMPS[type];
    const dump = `-- a dump\n--\n\n${d.head}\n\nCREATE DATABASE shop;\n`;
    // What the image's entrypoint leaves in an empty MariaDB: the login it checks the engine's health with.
    const res = seedSql(b, type, dump, () =>
      writeFileSync(
        join(b.data, ".my-healthcheck.cnf"),
        "[mariadb-client]\nuser=healthcheck\npassword=hc-secret\n",
      ),
    );
    assert.equal(res.code, 0, res.stderr);
    assert.ok(b.log().includes(d.called), b.log().join("\n"));
    // The copy logs in as itself, never as the database's own user.
    assert.ok(b.log().includes("password=pw-123_ABC"));
    const sql = readFileSync(join(b.root, "sql"), "utf8");
    assert.ok(sql.startsWith(dump), "the dump is loaded whole");
    assert.ok(sql.includes(`${d.follow}\n`), sql);
    if (type === "mariadb")
      // The image checks the copy's health with the login it made here, which the dump had replaced.
      assert.ok(
        sql.includes(
          "ALTER USER IF EXISTS healthcheck@'localhost' IDENTIFIED BY 'hc-secret';",
        ),
      );
    else assert.doesNotMatch(sql, /healthcheck/);
    assert.equal(
      readFileSync(join(b.data, "deplo-standby-seed"), "utf8"),
      "sby_1",
    );
    assert.equal(existsSync(join(b.data, "deplo-standby-following")), true);
  });

for (const type of ["mysql", "mariadb"] as const)
  test(`${type}: a dump that does not say where the binary log stood seeds nothing`, (t) => {
    const b = box(t);
    const res = seedSql(b, type, "-- a dump\nCREATE DATABASE shop;\n");
    assert.notEqual(res.code, 0);
    assert.match(
      res.stderr,
      /did not say where the database's binary log stood/,
    );
    assert.equal(existsSync(join(b.data, "deplo-standby-seed")), false);
    assert.doesNotMatch(readFileSync(join(b.root, "sql"), "utf8"), /CHANGE /);
  });

test("a MySQL or MariaDB promotion lets the copy finish what it received, then forgets its database", (t) => {
  for (const type of ["mysql", "mariadb"] as const) {
    const b = box(t);
    const client = type === "mysql" ? "mysql" : "mariadb";
    b.tool(
      client,
      'case "$*" in *"SHOW REPLICA STATUS"*) echo "Replica_SQL_Running_State: Replica has read all relay log; waiting for more updates";; esac',
    );
    writeFileSync(join(b.data, "deplo-standby-following"), "");
    const res = b.run(row(type).promote.command[2], {
      MYSQL_ROOT_PASSWORD: "enginepw",
      MARIADB_ROOT_PASSWORD: "enginepw",
    });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(
      b.log().map((l) => l.replace(/^.* -e /, "")),
      [
        "STOP REPLICA IO_THREAD",
        "SHOW REPLICA STATUS\\G",
        "STOP REPLICA; RESET REPLICA ALL",
      ],
    );
    // A copy that stopped following is left as it is.
    const stale = box(t);
    stale.tool(client);
    const refused = stale.run(row(type).promote.command[2]);
    assert.equal(refused.code, 1);
    assert.deepEqual(stale.log(), []);
  }
});

test("a Redis promotion is refused half-way through a full copy, and otherwise stops following", (t) => {
  const promote = row("redis").promote.command[2];
  const b = box(t);
  b.tool(
    "redis-cli",
    'case "$*" in "info replication") printf "role:slave\\r\\nmaster_sync_in_progress:0\\r\\n";; *) echo OK;; esac',
  );
  writeFileSync(join(b.data, "deplo-standby-following"), "");
  assert.equal(b.run(promote).code, 0);
  assert.equal(b.log().at(-1), "redis-cli REPLICAOF NO ONE");

  const mid = box(t);
  mid.tool("redis-cli", 'printf "master_sync_in_progress:1\\r\\n"');
  writeFileSync(join(mid.data, "deplo-standby-following"), "");
  const res = mid.run(promote);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /still receiving its database's data/);
  assert.ok(!mid.log().includes("redis-cli REPLICAOF NO ONE"));
});

test("a Redis database that refuses the copy's login says what it answered", (t) => {
  const b = box(t);
  b.tool("redis-cli", 'echo "ERR unknown command ACL"');
  const res = b.run(row("redis").prepare({ ...args, port: 6379 }));
  assert.equal(res.code, 1);
  assert.equal(res.stderr.trim(), "ERR unknown command ACL");
  const fine = box(t);
  fine.tool("redis-cli", "echo OK");
  assert.equal(fine.run(row("redis").prepare({ ...args, port: 6379 })).code, 0);
  assert.deepEqual(fine.log(), [
    "redis-cli ACL SETUSER deplo_standby reset on >pw-123_ABC +psync +replconf +ping",
    "redis-cli CONFIG SET repl-backlog-size 67108864",
  ]);
});

test("a MongoDB database that is not a set yet says to redeploy it, and is not touched", (t) => {
  const prepare = row("mongodb").prepare({ ...args, port: 27017 });
  const b = box(t);
  b.tool("mongosh", "exit 3");
  const res = b.run(prepare, {
    MONGO_INITDB_ROOT_USERNAME: "app",
    MONGO_INITDB_ROOT_PASSWORD: "enginepw",
  });
  assert.equal(res.code, 1);
  assert.equal(
    res.stderr.trim(),
    "the database does not keep the log a standby copy reads yet. Redeploy it first.",
  );
  assert.equal(b.log().length, 1);
  const set = box(t);
  set.tool("mongosh");
  assert.equal(set.run(prepare).code, 0);
  assert.match(set.log()[1], /rs\.reconfig\(c\)/);
});
