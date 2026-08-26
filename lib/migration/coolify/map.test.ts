import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coolifyApplication,
  coolifyCompose,
  coolifyDatabase,
  coolifyDbKind,
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
} from "./map";
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
  const d = parseCoolifyFqdns(
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
});

test("parseCoolifyFqdns survives a bare host and refuses nonsense", () => {
  const d = parseCoolifyFqdns("app.acme.com, , not a url ,,");
  assert.deepEqual(
    d.map((x) => x.host),
    ["app.acme.com"],
  );
});

test("parseCoolifyFqdns keeps a compose stack's per-service domains apart", () => {
  const d = parseCoolifyFqdns(
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
    parseCoolifyFqdns("https://a.com,https://a.com,http://a.com").length,
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
  assert.deepEqual(r.buildOnlyKeys, ["BUILT"]);
  assert.deepEqual(r.sharedRefs, ["SMTP_HOST"]);
  assert.equal(r.masked, false);
});

// The single worst failure this adapter can have: a token without read:sensitive
// gets rows with NO value key at all, and importing them lands empty variables.
test("coolifyEnvBlob says when the values never arrived", () => {
  const r = coolifyEnvBlob([{ key: "APP_KEY" }, { key: "PLAIN" }]);
  assert.equal(r.masked, true);
  assert.equal(coolifyEnvBlob([]).masked, false);
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
