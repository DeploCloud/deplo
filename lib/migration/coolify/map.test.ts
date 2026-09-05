import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coolifyApplication,
  coolifyCompose,
  coolifyDatabase,
  coolifyDbKind,
  coolifyDbKindOf,
  coolifyDestination,
  coolifyEnvBlob,
  coolifyFallbackPort,
  coolifyIsPanelHost,
  coolifyMember,
  coolifyMounts,
  coolifyNotes,
  coolifyPorts,
  coolifySchedule,
  coolifyServer,
  parseCoolifyFqdns,
  withoutPanelInternals,
} from "./map";
import { mapMounts, parseEnvBlob } from "../map";
import type { CoolifyApplication, CoolifyDatabase } from "./client";

/**
 * Coolify's rows onto the shared model. Every shape here is one the real API
 * returns - the fqdn list, the base64 labels, the per-engine credential columns.
 */

/* ---- engines -------------------------------------------------------- */

test("coolifyDbKind answers in Deplo's own spelling", () => {
  assert.equal(coolifyDbKind("postgresql"), "postgres");
  assert.equal(coolifyDbKind("standalone-postgresql"), "postgres");
  assert.equal(coolifyDbKind("standalone-mongodb"), "mongo");
  assert.equal(coolifyDbKind("standalone-mysql"), "mysql");
  assert.equal(coolifyDbKind("standalone-mariadb"), "mariadb");
  assert.equal(coolifyDbKind("standalone-redis"), "redis");
  assert.equal(coolifyDbKind("standalone-clickhouse"), "clickhouse");
  // These two have no twin, but they still have to be RECOGNISED - a database
  // Deplo silently forgot is worse than one the report names.
  assert.equal(coolifyDbKind("standalone-keydb"), "keydb");
  assert.equal(coolifyDbKind("standalone-dragonfly"), "dragonfly");
  assert.equal(coolifyDbKind("standalone-cockroach"), null);
  assert.equal(coolifyDbKind(null), null);
});

// KeyDB's table in Coolify carries no `database_type` at all, so the row was
// dropped before the plan existed - a database that vanished without a line.
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

// Redis keeps its password in the resource's variables and in no column at all,
// so Deplo minted a new one: 300 keys arrived intact and every app that talked to
// it stopped working.
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

/* ---- domains -------------------------------------------------------- */

test("parseCoolifyFqdns reads the list, its ports and its paths", () => {
  const { value: d, notes } = parseCoolifyFqdns(
    "https://app.acme.com,https://api.acme.com:3000,http://old.acme.com/v1/",
  );
  assert.deepEqual(
    d.map((x) => [x.host, x.port, x.path, x.https, x.certificateType]),
    [
      ["app.acme.com", null, null, true, "letsencrypt"],
      ["api.acme.com", 3000, null, true, "letsencrypt"],
      ["old.acme.com", null, "/v1", false, "none"],
    ],
  );
  // Deplo strips no prefix of its own, because Coolify adds no middleware to undo.
  assert.equal(d[2].stripPath, false);
  // Every one of them SAID which scheme it was, so there is nothing to warn about.
  assert.deepEqual(notes, []);
});

test("an address that names no scheme is not promoted to https", () => {
  // Four one-click services arrived on letsencrypt this way, off :80, and every
  // http link anyone had written answered 404.
  const { value: d, notes } = parseCoolifyFqdns("uptimekuma6.acme.com");
  assert.deepEqual(
    d.map((x) => [x.host, x.https, x.certificateType]),
    [["uptimekuma6.acme.com", false, "none"]],
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /without http:\/\/ or https:\/\//);
});

test("parseCoolifyFqdns survives a bare host and refuses nonsense", () => {
  const { value: d } = parseCoolifyFqdns("app.acme.com, , not a url ,,");
  assert.deepEqual(
    d.map((x) => x.host),
    ["app.acme.com"],
  );
});

test("parseCoolifyFqdns keeps a compose stack's per-service domains apart", () => {
  const { value: d } = parseCoolifyFqdns(
    null,
    JSON.stringify({
      app: { domain: "https://app.acme.com:3000" },
      api: { domain: "https://api.acme.com" },
    }),
  );
  assert.deepEqual(
    d.map((x) => [x.serviceName, x.host, x.port, x.domainType]),
    [
      ["app", "app.acme.com", 3000, "compose"],
      ["api", "api.acme.com", null, "compose"],
    ],
  );
});

test("parseCoolifyFqdns names the same host once", () => {
  assert.equal(
    parseCoolifyFqdns("https://a.com,https://a.com,http://a.com").value.length,
    1,
  );
});

/* ---- storage -------------------------------------------------------- */

test("coolifyMounts splits volumes, binds and files", () => {
  const { mounts, notes } = coolifyMounts({
    persistent_storages: [
      { uuid: "s1", name: "app-data-ewc08w0", mount_path: "/app/storage" },
      { uuid: "s2", mount_path: "/etc/thing", host_path: "/srv/thing" },
      { uuid: "s3", name: "no-path" },
    ],
    file_storages: [
      { uuid: "f1", mount_path: "/etc/nginx/nginx.conf", content: "server {}" },
      { uuid: "f2", mount_path: "/var/lib/blobs", is_directory: true },
      { uuid: "f3", mount_path: "/etc/secret.conf" },
    ],
  });

  assert.deepEqual(
    mounts.map((m) => [m.type, m.volumeName ?? m.hostPath ?? m.filePath]),
    [
      ["volume", "app-data-ewc08w0"],
      ["bind", "/srv/thing"],
      ["file", "nginx.conf"],
    ],
  );
  // A directory and a file whose bytes did not come are both said out loud.
  assert.equal(notes.length, 2);
  assert.match(notes[0], /mounted DIRECTORY/);
  assert.match(notes[1], /did not come with its contents/);
});

test("coolifyMounts sends each storage down the channel that can carry it", () => {
  // Coolify files EVERY bind mount as a "file storage", a config file and a whole
  // data directory alike, and `fs_path` is the only column that says where it is
  // on the host. Unread, a directory and a binary file were dropped by BOTH
  // channels: no config file, and no bind for the data phase to copy.
  const { mounts, notes } = coolifyMounts({
    file_storages: [
      {
        uuid: "f1",
        fs_path: "/srv/site/nginx.conf",
        mount_path: "/etc/nginx/nginx.conf",
        content: "server {}",
      },
      {
        uuid: "f2",
        fs_path: "/srv/site/data",
        mount_path: "/data",
        is_directory: true,
      },
      {
        uuid: "f3",
        fs_path: "/srv/site/app.db",
        mount_path: "/app/app.db",
        content: "SQLite\u0000fmt",
      },
      {
        uuid: "f4",
        fs_path: "/etc/localtime",
        mount_path: "/etc/localtime",
        content: "TZif2\u0000\u0000",
      },
      { uuid: "f5", fs_path: "/srv/site/big.bin", mount_path: "/app/big.bin" },
      // No fs_path at all: nothing can carry it, and that has to be said.
      { uuid: "f6", mount_path: "/app/orphan", is_directory: true },
    ],
  });

  assert.deepEqual(
    mounts.map((m) => [m.type, m.type === "file" ? m.filePath : m.hostPath]),
    [
      ["file", "nginx.conf"],
      ["bind", "/srv/site/data"],
      ["bind", "/srv/site/app.db"],
      ["bind", "/srv/site/big.bin"],
    ],
  );
  // The machine's own file is not worth a line; the one nothing can carry is.
  assert.deepEqual(notes, [
    "/app/orphan is a mounted DIRECTORY on {panel} and it named no path on the host, so nothing of it could be copied.",
  ]);
});

// The name on the host has to stay whole - it is what the data copy reads - and
// the name the owner sees has to lose the panel's own id.
test("a volume keeps its host name and loses the panel's id", () => {
  const uuid = "q70abqiwnol18hhjwtxp1hnf";
  const { mounts } = coolifyMounts(
    {
      persistent_storages: [
        { uuid: "s1", name: `${uuid}-tinydata`, mount_path: "/data" },
        { uuid: "s2", name: `${uuid}_underscored`, mount_path: "/var/lib/x" },
        { uuid: "s3", name: "chosen-by-hand", mount_path: "/srv" },
      ],
    },
    uuid,
  );
  assert.deepEqual(
    mounts.map((m) => [m.volumeName, m.volumeAlias]),
    [
      [`${uuid}-tinydata`, "tinydata"],
      [`${uuid}_underscored`, "underscored"],
      ["chosen-by-hand", null],
    ],
  );

  // And it is the alias that becomes the volume this app mounts here.
  const { value } = mapMounts(mounts, { isCompose: false });
  assert.deepEqual(
    value.volumes.map((v) => v.name),
    ["tinydata", "underscored", "chosen-by-hand"],
  );
});

/* ---- environment variables ------------------------------------------ */

test("coolifyEnvBlob takes the resolved value and leaves previews behind", () => {
  const r = coolifyEnvBlob([
    { key: "APP_KEY", value: "$SERVICE_PASSWORD_APP", real_value: "aB3k9" },
    { key: "PLAIN", value: "yes" },
    { key: "ONLY_PREVIEW", value: "x", is_preview: true },
    { key: "BUILT", value: "b", is_buildtime: true, is_runtime: false },
    { key: "SHARED", value: "{{team.SMTP_HOST}}" },
    { key: "  ", value: "dropped" },
  ]);
  assert.equal(
    r.blob,
    "APP_KEY=aB3k9\nPLAIN=yes\nBUILT=b\nSHARED={{team.SMTP_HOST}}",
  );
  assert.deepEqual(r.previewKeys, ["ONLY_PREVIEW"]);
  // ...and their values ride along, for Deplo's own preview variables.
  assert.equal(r.previewBlob, "ONLY_PREVIEW=x");
  assert.deepEqual(r.buildOnlyKeys, ["BUILT"]);
  assert.deepEqual(r.sharedRefs, [
    { key: "SHARED", level: "team", sharedKey: "SMTP_HOST", whole: true },
  ]);
  assert.equal(r.masked, false);
});

// The bug this pins: a token that can actually run an import gets `real_value`,
// which is the panel HAVING ALREADY RESOLVED the reference away. Read the refs off
// it and they are empty on every real migration, while the value is still right.
test("a reference is read off the stored value, not the resolved one", () => {
  const r = coolifyEnvBlob([
    { key: "SMTP_HOST", value: "{{team.SMTP_HOST}}", real_value: "mail.acme" },
    {
      key: "URL",
      value: "https://{{server.HOST}}/api",
      real_value: "https://h/api",
    },
    { key: "PREVIEW_REF", value: "{{team.X}}", is_preview: true },
  ]);
  assert.equal(r.blob, "SMTP_HOST=mail.acme\nURL=https://h/api");
  assert.deepEqual(r.sharedRefs, [
    { key: "SMTP_HOST", level: "team", sharedKey: "SMTP_HOST", whole: true },
    { key: "URL", level: "server", sharedKey: "HOST", whole: false },
  ]);
});

// The single worst failure this adapter can have: a token without read:sensitive
// gets rows with NO value key at all, and importing them lands empty variables.
test("coolifyEnvBlob says when the values never arrived", () => {
  const r = coolifyEnvBlob([{ key: "APP_KEY" }, { key: "PLAIN" }]);
  assert.equal(r.masked, true);
  assert.equal(coolifyEnvBlob([]).masked, false);
});

// One normal variable in the list is enough for `masked` to stay false, so the
// whole safety net used to miss a value the panel simply refuses to repeat.
test("coolifyEnvBlob names the variables the panel would not answer for", () => {
  const r = coolifyEnvBlob([
    { key: "PLAIN", value: "yes" },
    { key: "DB_PASSWORD", is_shown_once: true },
    { key: "EMPTY_ON_PURPOSE", value: "" },
  ]);
  assert.equal(r.masked, false);
  assert.deepEqual(r.unreadableKeys, ["DB_PASSWORD"]);
  assert.equal(r.blob, "PLAIN=yes\nDB_PASSWORD=\nEMPTY_ON_PURPOSE=");
});

// The panel's own verdict is the only thing that types a variable secret: a
// shown-once row WITH a value lands write-only, one without stays plain so it
// can be filled in, and a credential-looking name means nothing.
test("coolifyEnvBlob carries the panel's shown-once flag, and only that", () => {
  const r = coolifyEnvBlob([
    { key: "API_TOKEN", value: "t0k3n", is_shown_once: true },
    { key: "DB_PASSWORD", is_shown_once: true },
    { key: "STRIPE_SECRET", value: "sk_live", is_shown_once: false },
  ]);
  assert.deepEqual(r.secretKeys, ["API_TOKEN"]);
  assert.deepEqual(r.unreadableKeys, ["DB_PASSWORD"]);
  const app = coolifyApplication(
    { uuid: "a1", name: "web", build_pack: "nixpacks" } as never,
    { env: r.blob, secretEnvKeys: r.secretKeys },
  );
  assert.deepEqual(app.secretEnvKeys, ["API_TOKEN"]);
});

test("a dollar the panel would have interpolated is named; a literal one is not", () => {
  const r = coolifyEnvBlob([
    { key: "LITERAL", value: "pa$$w0rd$1", is_literal: true },
    { key: "OPEN", value: "pa$$w0rd$1", is_literal: false },
    {
      key: "REF",
      value: "{{project.SHARED}}",
      real_value: "x$y",
      is_literal: false,
    },
    { key: "PLAIN", value: "hello", is_literal: false },
  ]);
  assert.deepEqual(r.interpolatedKeys, ["OPEN"]);
  assert.match(r.blob, /LITERAL=pa\$\$w0rd\$1/);
});

test("a multi-line value survives the blob it travels in", () => {
  const key = "-----BEGIN PLAIN-----\nLINE1\nLINE2\n-----END PLAIN-----";
  const r = coolifyEnvBlob([
    { key: "PLAIN_MULTI", value: key },
    { key: "AFTER", value: "still here" },
  ]);
  assert.deepEqual(parseEnvBlob(r.blob), [
    { key: "PLAIN_MULTI", value: key },
    { key: "AFTER", value: "still here" },
  ]);
});

test("a multi-line value the panel already quoted is not quoted twice", () => {
  const r = coolifyEnvBlob([
    { key: "QUOTED", value: "'-----BEGIN-----\nBODY\n-----END-----'" },
  ]);
  assert.deepEqual(parseEnvBlob(r.blob), [
    { key: "QUOTED", value: "-----BEGIN-----\nBODY\n-----END-----" },
  ]);
});

/* ---- ports ---------------------------------------------------------- */

test("coolifyPorts reads a mapping list", () => {
  assert.deepEqual(
    coolifyPorts("8080:80, 9000, 5353:53/udp, junk").map((p) => [
      p.publishedPort,
      p.targetPort,
      p.protocol,
    ]),
    [
      [8080, 80, null],
      [9000, 9000, null],
      [5353, 53, "udp"],
    ],
  );
  assert.deepEqual(coolifyPorts(null), []);
});

/* ---- applications --------------------------------------------------- */

const APP: CoolifyApplication = {
  uuid: "app-1",
  name: "web",
  build_pack: "nixpacks",
  git_repository: "https://github.com/acme/web",
  git_branch: "main",
  ports_exposes: "3000,3001",
  fqdn: "https://web.acme.com",
  limits_memory: "512M",
  limits_cpus: "0.5",
  watch_paths: "apps/web\n\npackages/ui",
  start_command: "node server.js",
};

test("an application arrives as plain git, because that is what Coolify gives", () => {
  const a = coolifyApplication(APP, {
    serverId: "srv-1",
    environmentId: "2",
  });
  assert.equal(a.sourceType, "git");
  assert.equal(a.buildType, "nixpacks");
  assert.equal(a.customGitUrl, "https://github.com/acme/web");
  assert.equal(a.customGitBranch, "main");
  assert.deepEqual(a.watchPaths, ["apps/web", "packages/ui"]);
  assert.equal(a.memoryLimit, "512M");
  assert.equal(a.serverId, "srv-1");
  assert.deepEqual(
    a.domains?.map((d) => d.host),
    ["web.acme.com"],
  );
  assert.equal(coolifyFallbackPort(APP), 3000);
});

test("a prebuilt image is a docker source, not a build", () => {
  const a = coolifyApplication({
    uuid: "app-2",
    build_pack: "dockerimage",
    docker_registry_image_name: "ghcr.io/acme/api",
    docker_registry_image_tag: "1.4.0",
  });
  assert.equal(a.sourceType, "docker");
  assert.equal(a.dockerImage, "ghcr.io/acme/api:1.4.0");
});

test("an image app is not told it arrived as the panel's own repository", () => {
  const a = coolifyApplication({
    uuid: "app-3",
    build_pack: "dockerimage",
    docker_registry_image_name: "ghcr.io/acme/api",
    // What the API answers for EVERY image app: its own repository, as a default.
    git_repository: "coollabsio/coolify",
  });
  assert.deepEqual(a.platformNotes, []);
});

test("a Dockerfile in a subdirectory keeps its path", () => {
  const a = coolifyApplication({
    uuid: "app-4",
    build_pack: "dockerfile",
    git_repository: "https://github.com/acme/mono",
    dockerfile_location: "/docker/Dockerfile",
    dockerfile: "FROM node:22\nRUN true",
  });
  assert.equal(a.dockerfile, "docker/Dockerfile");
});

test("basic auth comes across as one credential", () => {
  const a = coolifyApplication(APP, {
    basicAuth: { username: "ops", password: "pw" },
  });
  assert.deepEqual(
    a.security?.map((s) => [s.username, s.password]),
    [["ops", "pw"]],
  );
});

/* ---- compose -------------------------------------------------------- */

test("a stack keeps the compose its author wrote", () => {
  const raw = "services:\n  app:\n    image: nginx\n";
  const { value, notes } = coolifyCompose({
    uuid: "svc-1",
    name: "wordpress",
    docker_compose_raw: raw,
    docker_compose: "services:\n  app:\n    container_name: app-ewc08w0\n",
  });
  assert.equal(value.composeFile, raw);
  assert.deepEqual(notes, []);
});

test("with no authored copy the rendered one comes across, and says so", () => {
  const { value, notes } = coolifyCompose({
    uuid: "svc-2",
    docker_compose: "services:\n  app:\n    image: nginx\n",
  });
  assert.match(value.composeFile ?? "", /^services:/);
  assert.equal(notes.length, 1);
  // The note carries the token, never a product's name.
  assert.match(notes[0], /\{panel\}/);
});

/* ---- servers, people, crons ----------------------------------------- */

test("the panel's own host is keyed as the panel's own host", () => {
  assert.equal(
    coolifyIsPanelHost({ uuid: "u", ip: "host.docker.internal" }),
    true,
  );
  assert.equal(coolifyIsPanelHost({ uuid: "u", id: 0, ip: "10.0.0.1" }), true);
  assert.equal(
    coolifyServer({ uuid: "u", id: 0, name: "localhost" }).serverId,
    "",
  );
  const remote = coolifyServer({
    uuid: "srv-9",
    id: 3,
    name: "eu-1",
    ip: "1.2.3.4",
  });
  assert.deepEqual(
    [remote.serverId, remote.name, remote.ipAddress],
    ["srv-9", "eu-1", "1.2.3.4"],
  );
});

test("a member arrives without a role, because Coolify hides it", () => {
  const m = coolifyMember({ id: 7, name: "Ada", email: "ada@acme.com" });
  assert.equal(m.role, null);
  assert.equal(m.email, "ada@acme.com");
});

test("a schedule's word becomes a cron expression", () => {
  assert.equal(
    coolifySchedule({ uuid: "t1", name: "prune", frequency: "daily" })
      .cronExpression,
    "0 0 * * *",
  );
  assert.equal(
    coolifySchedule({ uuid: "t2", name: "x", frequency: "*/5 * * * *" })
      .cronExpression,
    "*/5 * * * *",
  );
});

test("a backup destination needs its credentials to be worth importing", () => {
  assert.equal(
    coolifyDestination({
      uuid: "s3-1",
      endpoint: "https://s3.acme.com",
      bucket: "b",
    }),
    null,
  );
  assert.deepEqual(
    coolifyDestination({
      uuid: "s3-2",
      name: "backups",
      endpoint: "https://s3.acme.com",
      bucket: "b",
      key: "AK",
      secret: "SK",
    }),
    {
      name: "backups",
      endpoint: "https://s3.acme.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "AK",
      secretAccessKey: "SK",
    },
  );
});

/* ---- what has no twin ----------------------------------------------- */

// Measured on 4.3.16: the basic auth the import carries through its own columns
// is ALSO a custom label, with the htpasswd line as its value - and the report
// printed the hash. Coolify's own label is dropped; a hand-written one is named
// without its credential.
test("coolifyNotes never puts a basic-auth credential in the report", () => {
  const notes = coolifyNotes({
    uuid: "app-9",
    build_pack: "dockerimage",
    custom_labels: Buffer.from(
      [
        "traefik.http.middlewares.http-basic-auth-app-9.basicauth.users=mxadmin:$2y$10$abcdefghijklmnopqrstuv",
        "traefik.http.routers.http-0-app-9.middlewares=http-basic-auth-app-9",
        "traefik.http.middlewares.staff.basicauth.users=ops:$apr1$xyz",
        "traefik.http.middlewares.staff.basicauth.usersfile=/etc/htpasswd",
      ].join("\n"),
      "utf8",
    ).toString("base64"),
  });
  assert.equal(notes.length, 1);
  assert.doesNotMatch(notes[0], /\$2y\$|\$apr1\$|http-basic-auth-app-9/);
  assert.match(notes[0], /staff\.basicauth\.users=<credentials>/);
  assert.match(notes[0], /staff\.basicauth\.usersfile=<credentials>/);
});

test("coolifyNotes names everything Deplo has nowhere to put", () => {
  const notes = coolifyNotes({
    uuid: "app-3",
    build_pack: "dockerfile",
    custom_labels: Buffer.from(
      "traefik.enable=true\ncom.acme.tier=web\n",
      "utf8",
    ).toString("base64"),
    custom_docker_run_options: "--gpus all",
    custom_network_aliases: "legacy-api",
    pre_deployment_command: "php artisan down",
    pre_deployment_command_container: "app",
    post_deployment_command: "php artisan up",
    redirect: "www",
    limits_cpuset: "0-1",
    limits_memory_swap: "1G",
    health_check_enabled: true,
    health_check_method: "POST",
    health_check_return_code: 204,
  });
  const all = notes.join("\n");

  // Traefik's own labels are Deplo's grammar, and go in silence.
  assert.doesNotMatch(all, /traefik\.enable/);
  assert.match(all, /com\.acme\.tier=web/);
  assert.match(all, /--gpus all/);
  assert.match(all, /legacy-api/);
  assert.match(all, /ran before every deploy/);
  assert.match(all, /ran after every deploy/);
  assert.match(all, /bare domain to www/);
  assert.match(all, /CPUs 0-1/);
  assert.match(all, /memory swap limit of 1G/);
  assert.match(all, /method POST/);
  assert.match(all, /expected code 204/);
  assert.match(all, /Dockerfile was typed into/);
  // Every one of them speaks about the panel through the token.
  assert.doesNotMatch(all, /Dokploy|Coolify/);
});

test("an application with nothing exotic produces no notes", () => {
  assert.deepEqual(coolifyNotes(APP), []);
});

/* ---- the fixes ------------------------------------------------------- */

test("the engine is read off `database_type`, which is what the API answers with", () => {
  // Coolify 4.x spells it `database_type` on the list AND the detail endpoints.
  // Reading `type` alone found nothing, and every database was dropped in
  // silence - no import, no report line, nothing.
  assert.equal(
    coolifyDbKindOf({ database_type: "standalone-postgresql" }),
    "postgres",
  );
  assert.equal(coolifyDbKindOf({ type: "standalone-redis" }), "redis");
  assert.equal(coolifyDbKindOf({}), null);
});

test("a short repository is joined to the host its source lives on", () => {
  // A public repo carries a whole URL; one behind a source carries `owner/repo`
  // and `git clone mdn/beginner-html-site` is what that became.
  const short = coolifyApplication({
    ...APP,
    git_repository: "mdn/beginner-html-site",
    source_type: "App\\Models\\GithubApp",
  });
  assert.equal(
    short.customGitUrl,
    "https://github.com/mdn/beginner-html-site.git",
  );

  const gitlab = coolifyApplication({
    ...APP,
    git_repository: "group/sub/app",
    source_type: "App\\Models\\GitlabApp",
  });
  assert.equal(gitlab.customGitUrl, "https://gitlab.com/group/sub/app.git");

  // A self-hosted source names its own host, and that always wins.
  const own = coolifyApplication({
    ...APP,
    git_repository: "team/app",
    source_type: "App\\Models\\GiteaApp",
    source: { html_url: "https://git.acme.com/" },
  });
  assert.equal(own.customGitUrl, "https://git.acme.com/team/app.git");

  // A whole URL is kept byte for byte, and so is an ssh remote.
  assert.equal(
    coolifyApplication(APP).customGitUrl,
    "https://github.com/acme/web",
  );
  assert.equal(
    coolifyApplication({ ...APP, git_repository: "git@git.acme.com:t/a.git" })
      .customGitUrl,
    "git@git.acme.com:t/a.git",
  );
});

test("a repository with no source at all says github was assumed", () => {
  const a = coolifyApplication({ ...APP, git_repository: "acme/web" });
  assert.equal(a.customGitUrl, "https://github.com/acme/web.git");
  assert.ok(
    a.platformNotes?.some((n) => n.includes("Change it under Source")),
    "the guess has to be said out loud",
  );
});

test("an application carries the port it listens on", () => {
  // Without it every migrated app landed on Deplo's default 3000 and answered 502.
  assert.equal(coolifyApplication(APP).routingPort, 3000);
  assert.equal(
    coolifyApplication({ ...APP, ports_exposes: "" }).routingPort,
    null,
  );
});

test("a service's address comes from SERVICE_FQDN_*, which is where Coolify keeps it", () => {
  // `services` has no fqdn column at all: 25 of 25 one-click services arrived
  // with no domain while their own variables spelled one out.
  const raw = [
    "services:",
    "  it-tools:",
    "    image: corentinth/it-tools",
    "  worker:",
    "    image: busybox",
  ].join("\n");
  const { value } = coolifyCompose(
    { uuid: "svc-1", name: "it-tools", docker_compose_raw: raw },
    {
      env: [
        "SERVICE_FQDN_ITTOOLS_8080=https://tools.acme.com",
        "SERVICE_URL_ITTOOLS=tools.acme.com",
        "NOT_A_DOMAIN=x",
      ].join("\n"),
    },
  );
  assert.deepEqual(
    value.domains?.map((d) => [d.host, d.port, d.serviceName, d.https]),
    [["tools.acme.com", 8080, "it-tools", true]],
  );
});

test("a SERVICE_FQDN naming no service still brings the address over", () => {
  const { value } = coolifyCompose(
    {
      uuid: "svc-2",
      name: "ghost",
      docker_compose_raw: "services:\n  cms:\n    image: ghost\n",
    },
    { env: "SERVICE_FQDN_GHOST=https://blog.acme.com" },
  );
  assert.deepEqual(
    value.domains?.map((d) => [d.host, d.port, d.serviceName]),
    [["blog.acme.com", null, null]],
  );
});

test("two variables for one host are merged, whichever order they arrive in", () => {
  // Coolify keeps SERVICE_FQDN_X and SERVICE_FQDN_X_<PORT> for the same address.
  // Taking the first meant linkding drew the one without a port, its domain
  // landed with none, and Traefik had nowhere to send it: 502.
  const withPort = { url: "linkding.acme.com:9090", service: null, port: 9090 };
  const without = { url: "linkding.acme.com", service: null, port: null };

  for (const order of [
    [without, withPort],
    [withPort, without],
  ]) {
    const { value } = parseCoolifyFqdns(null, null, order);
    assert.deepEqual(
      value.map((d) => [d.host, d.port]),
      [["linkding.acme.com", 9090]],
      `order ${order === undefined ? "" : JSON.stringify(order.map((o) => o.url))}`,
    );
  }
});

test("a scheme on either spelling is believed for the merged host", () => {
  const bare = { url: "app.acme.com", service: null, port: null };
  const secure = {
    url: "https://app.acme.com:8443",
    service: null,
    port: 8443,
  };

  for (const order of [
    [bare, secure],
    [secure, bare],
  ]) {
    const { value, notes } = parseCoolifyFqdns(null, null, order);
    assert.deepEqual(
      value.map((d) => [d.host, d.port, d.https, d.certificateType]),
      [["app.acme.com", 8443, true, "letsencrypt"]],
    );
    // One of them DID say https, so there is nothing to warn about.
    assert.deepEqual(notes, []);
  }
});

test("SERVICE_FQDN_X and SERVICE_FQDN_X_PORT reach one domain with the port", () => {
  const raw = "services:\n  linkding:\n    image: sissbruecker/linkding\n";
  const { value } = coolifyCompose(
    { uuid: "svc-ld", name: "linkding", docker_compose_raw: raw },
    {
      env: [
        "SERVICE_FQDN_LINKDING=linkding.acme.com",
        "SERVICE_FQDN_LINKDING_9090=linkding.acme.com:9090",
      ].join("\n"),
    },
  );
  assert.deepEqual(
    value.domains?.map((d) => [d.host, d.port, d.serviceName]),
    [["linkding.acme.com", 9090, "linkding"]],
  );
});

test("the port survives when only the variable NAME carries it", () => {
  // What Coolify actually stores: it resolves BOTH spellings to the same URL, so
  // the port exists nowhere but the key. Whichever order they arrive in, the
  // domain must land with 9090 - a portless compose domain falls back to the
  // stack's default port and answers 502.
  const raw = "services:\n  linkding:\n    image: sissbruecker/linkding\n";
  const vars = [
    "SERVICE_FQDN_LINKDING=https://linkding.acme.com",
    "SERVICE_FQDN_LINKDING_9090=https://linkding.acme.com",
  ];
  for (const env of [vars.join("\n"), [...vars].reverse().join("\n")]) {
    const { value } = coolifyCompose(
      { uuid: "svc-ld", name: "linkding", docker_compose_raw: raw },
      { env },
    );
    assert.deepEqual(
      value.domains?.map((d) => [d.host, d.port, d.serviceName]),
      [["linkding.acme.com", 9090, "linkding"]],
      env,
    );
  }
});

test("a dockercompose application's own address gets a service and a port", () => {
  // Coolify's commonest Application shape after nixpacks: the address is on the
  // APPLICATION, not on a compose service, so the domain arrived naming neither
  // and Deplo rendered no router at all - a 404 on every one of them.
  const raw = [
    "services:",
    "  web:",
    "    image: acme/web",
    "    ports:",
    "      - 8000:8000",
    "  worker:",
    "    image: acme/worker",
    "",
  ].join("\n");
  const { value } = coolifyCompose({
    uuid: "app-1",
    name: "stack-git",
    build_pack: "dockercompose",
    fqdn: "https://stack.acme.com",
    ports_exposes: "8000",
    docker_compose_raw: raw,
  } as CoolifyApplication);

  assert.deepEqual(
    value.domains?.map((d) => [d.host, d.port, d.serviceName]),
    [["stack.acme.com", 8000, "web"]],
  );
  assert.equal(value.routingPort, 8000);
  assert.match(value.platformNotes?.join(" ") ?? "", /routes it to "web"/);
});

test("two services exposing a port is a question, not a default", () => {
  const raw = [
    "services:",
    "  web:",
    "    image: acme/web",
    "    ports:",
    "      - 8000:8000",
    "  api:",
    "    image: acme/api",
    "    ports:",
    "      - 9000:9000",
    "",
  ].join("\n");
  const { value } = coolifyCompose({
    uuid: "app-2",
    name: "two",
    build_pack: "dockercompose",
    fqdn: "https://two.acme.com",
    ports_exposes: "8000",
    docker_compose_raw: raw,
  } as CoolifyApplication);
  assert.equal(value.domains?.[0].serviceName, null);
  assert.equal(
    value.platformNotes?.some((n) => /routes it to/.test(n)),
    false,
  );
});

test("custom labels Coolify never encoded are read as they came", () => {
  // Measured: Coolify answers `custom_labels` in CLEAR for any app it never
  // deployed. `Buffer.from(x, "base64")` does not throw on that - it drops the
  // bytes it cannot read - so the report used to invent a label out of mojibake
  // and hide the real ones behind it.
  const plain = "com.acme.team=core\ncom.acme.tier=web";
  const notes = coolifyNotes({
    uuid: "a",
    custom_labels: plain,
  } as CoolifyApplication);
  assert.match(notes.join(" "), /com\.acme\.team=core, com\.acme\.tier=web/);

  // And a real base64 payload still decodes.
  const encoded = Buffer.from(plain).toString("base64");
  assert.deepEqual(
    coolifyNotes({ uuid: "a", custom_labels: encoded } as CoolifyApplication),
    notes,
  );
});

test("a config file is named after the source its own compose binds", () => {
  const compose = [
    "services:",
    "  filebrowser:",
    "    image: filebrowser/filebrowser",
    "    volumes:",
    "      - ./filebrowser.json:/.filebrowser.json",
  ].join("\n");
  const { value } = coolifyCompose(
    {
      uuid: "svc-fb",
      name: "filebrowser",
      docker_compose_raw: compose,
    } as unknown as CoolifyApplication,
    {
      mounts: [
        {
          mountId: "f1",
          type: "file",
          // What Coolify records: the container path, whose basename is a
          // DIFFERENT string from the file the compose actually binds.
          filePath: ".filebrowser.json",
          content: "{}",
          mountPath: "/.filebrowser.json",
        },
      ],
    },
  );
  assert.equal(value.mounts?.[0].filePath, "filebrowser.json");
  assert.equal(value.mounts?.[0].mountPath, "/.filebrowser.json");
});

test("the same file named by the panel's own absolute path lands the same way", () => {
  const compose = [
    "services:",
    "  app:",
    "    image: nginx",
    "    volumes:",
    "      - /data/coolify/services/svc-x/nginx.conf:/etc/nginx/nginx.conf",
  ].join("\n");
  const { value } = coolifyCompose(
    {
      uuid: "svc-x",
      name: "x",
      docker_compose_raw: compose,
    } as unknown as CoolifyApplication,
    {
      mounts: [
        {
          mountId: "f1",
          type: "file",
          filePath: "nginx.conf",
          content: "server {}",
          mountPath: "/etc/nginx/nginx.conf",
        },
      ],
    },
  );
  assert.equal(value.mounts?.[0].filePath, "nginx.conf");
});

test("Coolify's own bookkeeping never becomes a shared variable", () => {
  const blob = [
    "COOLIFY_SERVER_UUID=abc",
    "COOLIFY_SERVER_NAME=localhost",
    "SMTP_HOST=mail.acme.test",
  ].join("\n");
  assert.equal(withoutPanelInternals(blob), "SMTP_HOST=mail.acme.test");
  // Nothing of ours is dropped with them.
  assert.equal(withoutPanelInternals("A=1\nB=2"), "A=1\nB=2");
});

test("a member's role comes off the membership row Coolify sends with them", () => {
  assert.equal(
    coolifyMember({ id: 3, email: "a@acme.test", pivot: { role: "admin" } })
      .role,
    "admin",
  );
  // Nothing there is still nothing invented.
  assert.equal(coolifyMember({ id: 4, email: "b@acme.test" }).role, null);
});

test("a file storage says where it is on the host", () => {
  const { mounts } = coolifyMounts({
    file_storages: [
      {
        uuid: "f1",
        fs_path: "/srv/mxb1/single.conf",
        mount_path: "/srv/mxb1/single.conf",
        content: "a = 1",
      },
    ],
  });
  assert.equal(mounts[0]!.type, "file");
  assert.equal(mounts[0]!.hostPath, "/srv/mxb1/single.conf");
});

/* ---- what the audit of 4 set 2026 found dropped or doubled --------------- */

test("a compose build pack pointed at a repository keeps the repository", () => {
  const { value } = coolifyCompose({
    ...APP,
    uuid: "cmp-1",
    build_pack: "dockercompose",
    docker_compose_raw: "services:\n  web:\n    build: .\n",
    docker_compose_location: "/docker-compose.yml",
    base_directory: "/apps/web",
  });
  assert.equal(value.sourceType, "git");
  assert.equal(value.customGitUrl, "https://github.com/acme/web");
  assert.equal(value.customGitBranch, "main");
  assert.equal(value.composePath, "/docker-compose.yml");
  // No repository, no build: the raw file is the whole stack.
  const { value: raw } = coolifyCompose({
    uuid: "cmp-2",
    name: "kv",
    docker_compose_raw: "services:\n  kv:\n    image: alpine\n",
  });
  assert.equal(raw.sourceType, "raw");
});

test("the base directory is the build path once, never the context twice", () => {
  const a = coolifyApplication(
    { ...APP, build_pack: "dockerfile", base_directory: "/apps/web" },
    { serverId: "srv-1", environmentId: "2" },
  );
  assert.equal(a.customGitBuildPath, "/apps/web");
  assert.equal(a.dockerContextPath, null);
});

test("a publish directory only means static when the app is static", () => {
  const stale = coolifyApplication(
    { ...APP, build_pack: "nixpacks", publish_directory: "/dist" },
    { serverId: "srv-1", environmentId: "2" },
  );
  assert.equal(stale.publishDirectory, null);
  const site = coolifyApplication(
    { ...APP, build_pack: "static", publish_directory: "/dist" },
    { serverId: "srv-1", environmentId: "2" },
  );
  assert.equal(site.publishDirectory, "/dist");
});

test("the panel's own proxy labels are dropped, a middleware somebody wrote is named", () => {
  const labels = [
    "traefik.enable=true",
    "traefik.http.routers.app-1-https.rule=Host(`web.acme.com`)",
    "traefik.http.services.app-1-https.loadbalancer.server.port=3000",
    "traefik.http.middlewares.gzip.compress=true",
    "traefik.http.middlewares.office.ipallowlist.sourcerange=10.0.0.0/8",
    "caddy_0=https://web.acme.com",
    "com.acme.tier=gold",
  ].join("\n");
  const notes = coolifyNotes({
    ...APP,
    custom_labels: Buffer.from(labels).toString("base64"),
  });
  const line = notes.find((n) => /label/.test(n)) ?? "";
  assert.match(line, /ipallowlist/);
  assert.match(line, /com\.acme\.tier/);
  assert.doesNotMatch(line, /traefik\.enable|routers\.app-1|gzip|caddy_0/);
});

test("Coolify's build-step overrides come across", () => {
  const a = coolifyApplication(
    {
      ...APP,
      install_command: "pnpm i --frozen-lockfile",
      build_command: "pnpm build:prod",
    },
    { serverId: "srv-1", environmentId: "2" },
  );
  assert.equal(a.installCommand, "pnpm i --frozen-lockfile");
  assert.equal(a.buildCommand, "pnpm build:prod");
});
