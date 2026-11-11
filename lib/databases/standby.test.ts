import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { parse } from "yaml";

import { generateDatabaseCompose } from "../deploy/database-compose";
import {
  STANDBY_ENGINES,
  standbyContainer,
  standbyCost,
  standbyRefusal,
  standbySupport,
} from "./standby";

const pg = STANDBY_ENGINES.postgres!;
const args = {
  username: "app",
  dbName: "shop",
  port: 5432,
  password: "pw-123_ABC",
};

test("only an engine with a row keeps a standby copy, and the refusal names what is missing", () => {
  assert.deepEqual(Object.keys(STANDBY_ENGINES), ["postgres"]);
  const db = {
    name: "main",
    type: "postgres" as const,
    version: "17",
    customImage: null,
    customCommand: null,
  };
  assert.equal(standbySupport(db), null);
  assert.equal(
    standbySupport({ ...db, type: "redis" }),
    "A standby copy is available for PostgreSQL databases only.",
  );
  assert.equal(
    standbySupport({ ...db, version: "12" }),
    "A standby copy needs PostgreSQL 13 or newer. main runs 12.",
  );
  assert.equal(
    standbySupport({ ...db, customCommand: "postgres -c max_connections=500" }),
    "main starts with its own command, which a standby copy cannot follow. Remove the custom command first.",
  );
  assert.equal(
    standbySupport({ ...db, customImage: "acme/pg:1" }),
    "main runs an image of its own, which a standby copy cannot follow. Use the PostgreSQL image first.",
  );
  assert.equal(standbySupport({ ...db, customImage: "postgres:17.2" }), null);
});

test("the refusals of a placement read as sentences about the standby copy", () => {
  const names = { cluster: "eu", name: "main" };
  assert.equal(
    standbyRefusal("one_member", names),
    "Cluster eu has one server, so a standby copy of main has nowhere to run. Add a server to the cluster.",
  );
  assert.equal(
    standbyRefusal("no_room", { ...names, neededMb: 512 }),
    "No other server in cluster eu has 512 MB free for a standby copy of main. Add a server to it or lower main's memory.",
  );
  assert.equal(
    standbyRefusal("no_member_online", names),
    "No other server in cluster eu is online and ready right now, so a standby copy of main has nowhere to run. Bring a server back or add one.",
  );
  assert.equal(
    standbyRefusal("too_old", names),
    "No other server in cluster eu can keep a standby copy yet: their server agents need an update, which Deplo does on its own.",
  );
});

test("the switch states its memory and disk cost", () => {
  assert.equal(
    standbyCost({
      type: "postgres",
      resources: { memoryMb: 512 },
      sizeMb: 2048,
    }),
    "Uses 512 MB of memory on a second server and a second copy of its data (2 GiB). Its own server keeps up to 1 GiB more.",
  );
  assert.equal(
    standbyCost({ type: "postgres", resources: null, sizeMb: 0 }),
    "Uses as much memory as the database on a second server and a second copy of its data. Its own server keeps up to 1 GiB more.",
  );
});

test("the database is prepared with a login that may only replicate, and the password never sits in a file path or a name", () => {
  const script = pg.prepare(args);
  assert.match(script, /ALTER ROLE deplo_standby WITH REPLICATION LOGIN/);
  assert.ok(script.includes(`PASSWORD '\\''pw-123_ABC'\\''`));
  assert.match(script, /host replication deplo_standby all scram-sha-256/);
  assert.ok(script.includes(`wal_keep_size = '\\''1GB'\\''`));
  assert.match(script, /pg_reload_conf/);
  // Never `sed -i` on the access file: a replaced file would belong to root and lock the engine out.
  assert.doesNotMatch(script, /sed -i/);
  assert.doesNotMatch(pg.retire(args), /sed -i/);
  assert.match(pg.retire(args), /DROP ROLE IF EXISTS deplo_standby/);
});

test("the copy's stack never answers to the database's name, keeps its volume, and seeds only data it made", () => {
  const start = pg.start({ ...args, primaryHost: "db-main", seed: "sby_1" });
  const yaml = generateDatabaseCompose({
    name: "db-main",
    databaseId: "db_1",
    type: "postgres",
    version: "17",
    username: "app",
    password: "enginepw",
    dbName: "shop",
    hostPort: 25432,
    network: "deplo-env-e1",
    standby: start,
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
        labels: string[];
      }
    >;
    volumes: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(doc.services), ["db-main_standby"]);
  const svc = doc.services["db-main_standby"];
  assert.equal(svc.container_name, standbyContainer("db-main"));
  assert.equal(svc.container_name, "db-main_standby");
  // A published port belongs to the database, never to its copy.
  assert.equal(svc.ports, undefined);
  assert.deepEqual(svc.volumes, ["db-main-data:/var/lib/postgresql/data"]);
  assert.deepEqual(Object.keys(doc.volumes), ["db-main-data"]);
  assert.ok(svc.labels.includes("deplo.project=db_1"));
  assert.ok(svc.environment.includes("DEPLO_STANDBY_PASSWORD=pw-123_ABC"));
  assert.ok(svc.environment.includes("DEPLO_STANDBY_SEED=sby_1"));
  assert.deepEqual(svc.command.slice(0, 2), ["sh", "-c"]);
  // Every dollar is doubled for compose, which hands the shell one.
  assert.doesNotMatch(svc.command[2], /(^|[^$])\$([^$]|$)/);
  const script = svc.command[2].replaceAll("$$", "$");
  assert.match(script, /\$PGDATA\/deplo-standby-seed/);
  assert.match(
    script,
    /pg_basebackup -h db-main -p 5432 -U deplo_standby -D "\$PGDATA" -X stream -R/,
  );
  // The wipe is behind the seed check: data this copy seeded, or was promoted on, is never deleted.
  assert.ok(
    script.indexOf('!= "$DEPLO_STANDBY_SEED"') <
      script.indexOf('find "$PGDATA" -mindepth 1 -delete'),
  );
  assert.match(
    script,
    /exec docker-entrypoint\.sh postgres -c "primary_conninfo=host=db-main port=5432 user=deplo_standby password=\$DEPLO_STANDBY_PASSWORD"/,
  );
});

test("a promotion is refused by the copy itself when it had stopped following", () => {
  assert.equal(pg.promote.user, "postgres");
  const script = pg.promote.command.join(" ");
  assert.ok(
    script.indexOf("-mmin -15") < script.indexOf("pg_ctl promote"),
    "the check runs before the promotion",
  );
  assert.match(pg.check, /seeding/);
  assert.match(pg.check, /following/);
  assert.match(pg.check, /behind/);
});

test("every script of every engine row is shell a container's sh can read", () => {
  for (const [type, engine] of Object.entries(STANDBY_ENGINES)) {
    const start = engine.start({ ...args, primaryHost: "db-main", seed: "s" });
    const scripts = {
      prepare: engine.prepare(args),
      retire: engine.retire(args),
      check: engine.check,
      start: start.command.at(-1)!,
      promote: engine.promote.command.at(-1)!,
    };
    for (const [name, script] of Object.entries(scripts))
      assert.doesNotThrow(
        () => execFileSync("sh", ["-n", "-c", script], { stdio: "pipe" }),
        `${type}.${name} does not parse`,
      );
  }
});
