import { test } from "node:test";
import assert from "node:assert/strict";

import type { SourceDatabase } from "../model";
import { deploEngineFor, imageTag, mapDatabase } from "./databases";
import { db } from "./map-test-helpers";

test("imageTag reads the tag and ignores a registry port", () => {
  assert.equal(imageTag("postgres:16"), "16");
  assert.equal(imageTag("bitnami/postgresql:15.4"), "15.4");
  assert.equal(imageTag("reg.acme.com:5000/pg"), null);
  assert.equal(imageTag("reg.acme.com:5000/pg:14"), "14");
  assert.equal(imageTag("postgres"), null);
});

test("mapDatabase maps each engine Deplo has and refuses libsql", () => {
  assert.equal(mapDatabase("postgres", db()).value?.type, "postgres");
  assert.equal(
    mapDatabase("mongo", db({ dockerImage: "mongo:7" })).value?.type,
    "mongodb",
  );
  assert.equal(
    mapDatabase("redis", db({ dockerImage: "redis:7" })).value?.type,
    "redis",
  );

  const libsql = mapDatabase("libsql", db());
  assert.equal(libsql.value, null);
  assert.match(libsql.notes.join(" "), /no libsql engine/);
});

test("mapDatabase keeps the original password so imported env vars still match", () => {
  const { value } = mapDatabase("postgres", db());
  assert.equal(value?.password, "s3cret-value");
  assert.equal(value?.username, "app");
  assert.equal(value?.dbName, "app");
  assert.equal(value?.version, "16");
  // The data volume is copied byte for byte, so the source image is pinned: glibc and musl sort text differently.
  assert.equal(value?.customImage, "postgres:16");
});

test("mapDatabase pins the source image whatever shape the ref has", () => {
  const cases: [string, string, string][] = [
    ["postgres:18", "postgres:18", "18"],
    // a suffixed tag used to be re-suffixed into `postgres:16-alpine-alpine`
    ["postgres:16-alpine", "postgres:16-alpine", "16-alpine"],
    // no tag at all used to produce version "" and fail createDatabase; the ref stays verbatim and the report warns
    ["postgres", "postgres", "latest"],
    ["ghcr.io/org/pg:1", "ghcr.io/org/pg:1", "1"],
  ];
  for (const [image, wantImage, wantVersion] of cases) {
    const { value } = mapDatabase("postgres", db({ dockerImage: image }));
    assert.equal(value?.customImage, wantImage, image);
    assert.equal(value?.version, wantVersion, image);
  }
});

test("mapDatabase warns when the source image has no version pinned", () => {
  const { notes } = mapDatabase("postgres", db({ dockerImage: "postgres" }));
  assert.match(notes.join(" "), /no version pinned/);
});

test("mapDatabase pins a suffixed redis tag instead of re-suffixing it", () => {
  const { value } = mapDatabase("redis", db({ dockerImage: "redis:7-alpine" }));
  assert.equal(value?.customImage, "redis:7-alpine");
});

test("mapDatabase keeps a non-canonical image and says so", () => {
  const { value, notes } = mapDatabase(
    "postgres",
    db({ dockerImage: "pgvector/pgvector:pg16" }),
  );
  assert.equal(value?.customImage, "pgvector/pgvector:pg16");
  assert.equal(value?.version, "pg16");
  assert.match(notes.join(" "), /plain postgres/);
  // A canonical image is pinned too, but silently - there is nothing to warn about.
  assert.equal(
    mapDatabase("postgres", db()).notes.join(" ").includes("plain postgres"),
    false,
  );
});

test("mapDatabase carries the external port and reports what a database cannot take", () => {
  const { value, notes } = mapDatabase(
    "postgres",
    db({
      externalPort: 5432,
      command: "postgres -c max_connections=200",
      mounts: [
        {
          mountId: "1",
          type: "bind",
          hostPath: "/srv/pg",
          mountPath: "/srv/pg",
        },
      ],
    }),
  );
  assert.equal(value?.exposedPort, 5432);
  // The start command comes across (Deplo stores one too) instead of becoming a note asking someone to retype it.
  assert.equal(value?.command, "postgres -c max_connections=200");
  assert.doesNotMatch(notes.join(" "), /start command/);
  // A BIND has nowhere to go on a Deplo database, so it is named, not dropped in silence.
  assert.match(notes.join(" "), /bind-mounts/);
});

// Dokploy leaves `filePath` null on a database's file mount just as it does on an application's.
test("mapDatabase imports the engine's config files", () => {
  const { value, notes } = mapDatabase(
    "postgres",
    db({
      mounts: [
        {
          mountId: "1",
          type: "file",
          filePath: null,
          content: "shared_buffers = 1GB\n",
          mountPath: "/etc/postgresql.conf",
        },
      ],
    }),
  );
  assert.deepEqual(value?.mounts, [
    {
      filePath: "postgresql.conf",
      content: "shared_buffers = 1GB\n",
      mountPath: "/etc/postgresql.conf",
    },
  ]);
  assert.equal(
    notes.join(" ").includes("not imported"),
    false,
    notes.join(" "),
  );
});

// Dokploy models a database's DATA volume as a mount row: warning about it fired on EVERY database, over the one thing the Data step copies.
test("mapDatabase does not call the data volume an extra file mount", () => {
  const { notes } = mapDatabase(
    "postgres",
    db({
      appName: "project-db-abc123",
      mounts: [
        {
          mountId: "1",
          type: "volume",
          volumeName: "project-db-abc123-data",
          mountPath: "/var/lib/postgresql/18/docker",
        },
      ],
    }),
  );
  assert.equal(
    notes.join(" ").includes("mounted on {panel}"),
    false,
    notes.join(" "),
  );
});

// mysql/mariadb carry two credentials and Deplo models one, used for BOTH the connection string and its root-only operations.
test("mapDatabase imports mysql as root, because that is who Deplo acts as", () => {
  const { value, notes } = mapDatabase(
    "mysql",
    db({
      dockerImage: "mysql:8.4",
      databaseUser: "appuser",
      databasePassword: "app-pw",
      databaseRootPassword: "root-pw",
    }),
  );
  assert.equal(value?.username, "root");
  assert.equal(value?.password, "root-pw");
  assert.match(notes.join(" "), /Connects as root/);
});

// A panel that answers with ONE password for both used to get the changed login without the sentence that explains it.
test("mapDatabase says it connects as root even when both passwords match", () => {
  const { value, notes } = mapDatabase(
    "mysql",
    db({
      databaseUser: "appuser",
      databasePassword: "same",
      databaseRootPassword: "same",
    }),
  );
  assert.equal(value?.username, "root");
  assert.match(notes.join(" "), /Connects as root/);
});

test("mapDatabase says nothing about root when root is already the user", () => {
  const { notes } = mapDatabase(
    "mysql",
    db({
      databaseUser: "root",
      databasePassword: "root-pw",
      databaseRootPassword: "root-pw",
    }),
  );
  assert.equal(notes.join(" ").includes("Connects as root"), false);
});

// Coolify keeps redis's password ONLY in the resource's variables, so counting it as left behind said the opposite of what happened.
test("mapDatabase does not count a carried credential as a lost variable", () => {
  const { notes } = mapDatabase(
    "redis",
    db({
      dockerImage: "redis:7",
      databaseUser: "default",
      databasePassword: "r3dis-pw",
      env: "REDIS_PASSWORD=r3dis-pw\nREDIS_USERNAME=default\nTZ=Europe/Rome",
    }),
  );
  assert.match(notes.join(" "), /TZ/);
  assert.equal(notes.join(" ").includes("REDIS_PASSWORD"), false);
  assert.match(notes.join(" "), /1 environment variable/);
});

test("mapDatabase keeps the application user for engines with a single credential", () => {
  const { value } = mapDatabase(
    "postgres",
    db({
      databaseUser: "appuser",
      databasePassword: "app-pw",
      databaseRootPassword: "root-pw",
    }),
  );
  assert.equal(value?.username, "appuser");
  assert.equal(value?.password, "app-pw");
});

test("mapDatabase names the environment variables a Deplo database cannot hold", () => {
  const { notes } = mapDatabase(
    "postgres",
    db({ env: "POSTGRES_INITDB_ARGS=--data-checksums\nTZ=Europe/Rome" }),
  );
  const joined = notes.join(" ");
  assert.match(joined, /POSTGRES_INITDB_ARGS/);
  assert.match(joined, /TZ/);
});

test("mapDatabase still asks for a MULTI-LINE start command by hand", () => {
  const { value, notes } = mapDatabase("postgres", db({ command: "a\nb" }));
  assert.equal(value?.command, null);
  assert.match(notes.join(" "), /more than one line/);
});

test("deploEngineFor answers for both platforms' spellings", () => {
  assert.equal(deploEngineFor("postgres"), "postgres");
  assert.equal(deploEngineFor("postgresql"), "postgres");
  assert.equal(deploEngineFor("mongo"), "mongodb");
  assert.equal(deploEngineFor("mongodb"), "mongodb");
  assert.equal(deploEngineFor("clickhouse"), "clickhouse");
  // No twin: the report has to say so rather than guess one.
  assert.equal(deploEngineFor("keydb"), null);
  assert.equal(deploEngineFor("dragonfly"), null);
  assert.equal(deploEngineFor("libsql"), null);
});

test("mapDatabase refuses an engine Deplo does not have", () => {
  const { value, notes } = mapDatabase(
    "keydb" as never,
    {
      name: "cache",
    } as SourceDatabase,
  );
  assert.equal(value, null);
  assert.ok(notes[0].includes("no keydb engine"));
});
