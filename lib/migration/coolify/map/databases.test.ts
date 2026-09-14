import { test } from "node:test";
import assert from "node:assert/strict";

import { coolifyDatabase, coolifyDbKind, coolifyDbKindOf } from "./databases";
import type { CoolifyDatabase } from "../client";

test("coolifyDbKind answers in Deplo's own spelling", () => {
  assert.equal(coolifyDbKind("postgresql"), "postgres");
  assert.equal(coolifyDbKind("standalone-postgresql"), "postgres");
  assert.equal(coolifyDbKind("standalone-mongodb"), "mongo");
  assert.equal(coolifyDbKind("standalone-mysql"), "mysql");
  assert.equal(coolifyDbKind("standalone-mariadb"), "mariadb");
  assert.equal(coolifyDbKind("standalone-redis"), "redis");
  assert.equal(coolifyDbKind("standalone-clickhouse"), "clickhouse");
  // These two have no twin, but they still have to be RECOGNISED - a database Deplo silently forgot is worse than one the report names.
  assert.equal(coolifyDbKind("standalone-keydb"), "keydb");
  assert.equal(coolifyDbKind("standalone-dragonfly"), "dragonfly");
  assert.equal(coolifyDbKind("standalone-cockroach"), null);
  assert.equal(coolifyDbKind(null), null);
});

// KeyDB's table in Coolify carries no `database_type` at all, so the row was dropped before the plan existed - a database that vanished without a line.
test("an engine with no column of its own is read off the image", () => {
  assert.equal(
    coolifyDbKindOf({ image: "eqalpha/keydb:6.3" } as CoolifyDatabase),
    "keydb",
  );
  assert.equal(
    coolifyDbKindOf({ image: "bitnami/postgresql:16" } as CoolifyDatabase),
    "postgres",
  );
  assert.equal(
    coolifyDbKindOf({ image: "mongo:7" } as CoolifyDatabase),
    "mongo",
  );
  // The column still wins when it is there.
  assert.equal(
    coolifyDbKindOf({
      database_type: "standalone-redis",
      image: "eqalpha/keydb:6.3",
    } as CoolifyDatabase),
    "redis",
  );
  // And a row neither names is not guessed at.
  assert.equal(
    coolifyDbKindOf({ image: "acme/our-own-store:2" } as CoolifyDatabase),
    null,
  );
});

// Redis keeps its password in the resource's variables and in no column at all, so Deplo minted a new one: 300 keys arrived and every app talking to it stopped working.
test("a credential kept only in the variables still comes across", () => {
  const redis = coolifyDatabase(
    { uuid: "db-r", name: "cache", image: "redis:7" } as CoolifyDatabase,
    "redis",
    { env: "REDIS_PASSWORD=R3dis@Pass1\nREDIS_USERNAME=cacher\n" },
  );
  assert.equal(redis.databasePassword, "R3dis@Pass1");
  assert.equal(redis.databaseUser, "cacher");

  // The column still wins where there is one.
  const pg = coolifyDatabase(
    {
      uuid: "db-p",
      postgres_password: "from-the-column",
    } as unknown as CoolifyDatabase,
    "postgres",
    { env: "POSTGRES_PASSWORD=from-the-env\n" },
  );
  assert.equal(pg.databasePassword, "from-the-column");
});

test("a database's credentials are read from its own engine's columns", () => {
  const pg = coolifyDatabase(
    {
      uuid: "db-1",
      name: "main",
      image: "postgres:16",
      postgres_user: "app",
      postgres_password: "s3cret",
      postgres_db: "appdb",
      is_public: true,
      public_port: 5433,
    } as unknown as CoolifyDatabase,
    "postgres",
  );
  assert.equal(pg.postgresId, "db-1");
  assert.equal(pg.databaseUser, "app");
  assert.equal(pg.databasePassword, "s3cret");
  assert.equal(pg.databaseName, "appdb");
  assert.equal(pg.externalPort, 5433);
  assert.equal(pg.dockerImage, "postgres:16");

  const my = coolifyDatabase(
    {
      uuid: "db-2",
      mysql_user: "u",
      mysql_password: "p",
      mysql_database: "d",
      mysql_root_password: "r",
    } as unknown as CoolifyDatabase,
    "mysql",
  );
  assert.equal(my.databaseRootPassword, "r");

  const mongo = coolifyDatabase(
    {
      uuid: "db-3",
      mongo_initdb_root_username: "root",
      mongo_initdb_root_password: "pw",
    } as unknown as CoolifyDatabase,
    "mongo",
  );
  assert.equal(mongo.databaseUser, "root");
  assert.equal(mongo.databasePassword, "pw");

  // Not public: the port is not an instruction to publish anything.
  const redis = coolifyDatabase(
    {
      uuid: "db-4",
      redis_password: "rp",
      is_public: false,
      public_port: 6380,
    } as unknown as CoolifyDatabase,
    "redis",
  );
  assert.equal(redis.externalPort, null);
  assert.equal(redis.databasePassword, "rp");
});

test("the engine is read off `database_type`, which is what the API answers with", () => {
  // Coolify 4.x spells it `database_type` on the list AND the detail endpoints; reading `type` alone found nothing and dropped every database in silence.
  assert.equal(
    coolifyDbKindOf({ database_type: "standalone-postgresql" }),
    "postgres",
  );
  assert.equal(coolifyDbKindOf({ type: "standalone-redis" }), "redis");
  assert.equal(coolifyDbKindOf({}), null);
});
