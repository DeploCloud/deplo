import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "js-yaml";

import {
  cloneTarget,
  composeVolumeMounts,
  deploDatabaseVolumeName,
  deploVolumeName,
  pairVolumes,
  sourceVolumesFrom,
  envNeedsInterpolation,
  imageTag,
  isThrowawayHost,
  mapBuildSettings,
  mapDatabase,
  mapDomains,
  mapMounts,
  mapResources,
  mapSource,
  parseCpuMilli,
  parseEnvBlob,
  parseMemoryMb,
  portNotes,
  repoNameFromUrl,
  adaptComposeForDeplo,
  volumeLabel,
  declaredSourceVolumes,
} from "./map";
import type { DokployApplication, DokployDatabase } from "./client";

/**
 * The pure half of the Dokploy import. Every case here is a shape a real Dokploy
 * row takes; the assertions are about what reaches deplo and about what ends up
 * in `notes`, because a note is the only thing standing between a config that
 * could not come across and a config that silently vanished.
 */

/** A minimal application row; each test overrides what it cares about. */
function app(over: Partial<DokployApplication> = {}): DokployApplication {
  return {
    applicationId: "app-1",
    name: "web",
    appName: "acme-web-abc123",
    sourceType: "github",
    buildType: "nixpacks",
    owner: "acme",
    repository: "web",
    branch: "main",
    ...over,
  };
}

/* ---- env blobs ------------------------------------------------------ */

test("parseEnvBlob follows the .env grammar deplo already uses", () => {
  const entries = parseEnvBlob(
    [
      "# a comment",
      "",
      "PLAIN=value",
      "QUOTED=\"with spaces\"",
      "SINGLE='single'",
      "export EXPORTED=shell-style",
      "EMPTY=",
      "WITH_EQUALS=a=b=c",
      "not a var line",
      "1BAD=nope",
      "SPACED = trimmed ",
    ].join("\n"),
  );
  assert.deepEqual(entries, [
    { key: "PLAIN", value: "value" },
    { key: "QUOTED", value: "with spaces" },
    { key: "SINGLE", value: "single" },
    { key: "EXPORTED", value: "shell-style" },
    { key: "EMPTY", value: "" },
    { key: "WITH_EQUALS", value: "a=b=c" },
    { key: "SPACED", value: "trimmed" },
  ]);
});

test("parseEnvBlob keeps the last value for a repeated key", () => {
  assert.deepEqual(parseEnvBlob("A=1\nB=2\nA=3"), [
    { key: "A", value: "3" },
    { key: "B", value: "2" },
  ]);
});

test("parseEnvBlob tolerates nothing at all", () => {
  assert.deepEqual(parseEnvBlob(null), []);
  assert.deepEqual(parseEnvBlob(""), []);
});

test("envNeedsInterpolation flags Dokploy's own template syntax", () => {
  const entries = parseEnvBlob("A=${{project.SHARED}}\nB=literal");
  assert.deepEqual(envNeedsInterpolation(entries), ["A"]);
});

/* ---- compose network rewrite ---------------------------------------- */

test("adaptComposeForDeplo removes Dokploy's network, declaration and every reference", () => {
  const source = [
    "services:",
    "  web:",
    "    image: nginx",
    "    networks:",
    "      - dokploy-network",
    "      - internal",
    "  worker:",
    "    image: busybox",
    "    networks:",
    "      - dokploy-network",
    "networks:",
    "  dokploy-network:",
    "    external: true",
    "  internal: {}",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source);
  assert.ok(changes.length > 0);
  const doc = yaml.load(compose) as {
    services: Record<string, { networks?: unknown }>;
    networks: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(doc.networks), ["internal"]);
  assert.deepEqual(doc.services.web.networks, ["internal"]);
  // The only entry was the shared network, so the key goes away entirely rather
  // than leaving `networks: []`, which compose rejects.
  assert.equal("networks" in doc.services.worker, false);
});

test("adaptComposeForDeplo resolves the network by name, not by key", () => {
  const source = [
    "services:",
    "  web:",
    "    image: nginx",
    "    networks:",
    "      shared: {}",
    "networks:",
    "  shared:",
    "    external: true",
    "    name: dokploy-network",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source);
  assert.ok(changes.length > 0);
  const doc = yaml.load(compose) as {
    services: Record<string, { networks?: unknown }>;
    networks?: unknown;
  };
  assert.equal(doc.networks, undefined);
  assert.equal("networks" in doc.services.web, false);
});

test("adaptComposeForDeplo also reads the nested external.name form", () => {
  const source = [
    "services:",
    "  web:",
    "    image: nginx",
    "networks:",
    "  aliased:",
    "    external:",
    "      name: dokploy-network",
  ].join("\n");
  const { compose, changes } = adaptComposeForDeplo(source);
  assert.ok(changes.length > 0);
  assert.equal((yaml.load(compose) as { networks?: unknown }).networks, undefined);
});

test("adaptComposeForDeplo leaves a clean compose byte-identical", () => {
  const source = "services:\n  web:\n    image: nginx # keep this comment\n";
  const { compose, changes } = adaptComposeForDeplo(source);
  assert.deepEqual(changes, []);
  assert.equal(compose, source);
});

test("adaptComposeForDeplo does not throw on YAML it cannot parse", () => {
  const broken = "services:\n  web:\n   - : :";
  assert.deepEqual(adaptComposeForDeplo(broken), {
    compose: broken,
    changes: [],
  });
});

test("adaptComposeForDeplo maps Dokploy's file mounts onto Deplo's convention", () => {
  // The single most common thing in a real Dokploy compose: the platform writes
  // the service's config next to the stack and the file binds it back in.
  const source = [
    "services:",
    "  ch:",
    "    image: clickhouse/clickhouse-server:25.5",
    "    volumes:",
    "      - clickhouse_data:/var/lib/clickhouse",
    "      - ../files/clickhouse_config:/etc/clickhouse-server/config.d",
    "      - ../files:/everything",
    "      - /srv/real-host-path:/host",
    "      - ../../elsewhere:/nope",
    "  long:",
    "    image: busybox",
    "    volumes:",
    "      - type: bind",
    "        source: ../files/one.conf",
    "        target: /etc/one.conf",
    "volumes:",
    "  clickhouse_data: {}",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source);
  const doc = yaml.load(compose) as {
    services: Record<string, { volumes: unknown[] }>;
  };
  assert.deepEqual(doc.services.ch.volumes, [
    // A named volume is untouched.
    "clickhouse_data:/var/lib/clickhouse",
    // Dokploy's files dir becomes Deplo's, which is what makes the imported file
    // mounts line up with the compose that reads them.
    "./clickhouse_config:/etc/clickhouse-server/config.d",
    ".:/everything",
    // A real host path stays a real host path, and goes on needing the grant.
    "/srv/real-host-path:/host",
    // So does an escape to anywhere that is not the files dir.
    "../../elsewhere:/nope",
  ]);
  assert.deepEqual(doc.services.long.volumes, [
    { type: "bind", source: "./one.conf", target: "/etc/one.conf" },
  ]);
  assert.equal(changes.length, 3);
});

test("adaptComposeForDeplo leaves a stack that needs neither rewrite alone", () => {
  const source = "services:\n  web:\n    image: nginx\n    volumes:\n      - data:/data\n";
  assert.deepEqual(adaptComposeForDeplo(source), { compose: source, changes: [] });
});

/* ---- build settings ------------------------------------------------- */

test("mapBuildSettings maps each build pack deplo has", () => {
  for (const [dokploy, deplo] of [
    ["dockerfile", "dockerfile"],
    ["nixpacks", "nixpacks"],
    ["railpack", "railpack"],
    ["static", "static"],
  ] as const) {
    const { value, notes } = mapBuildSettings(app({ buildType: dokploy }));
    assert.equal(value.buildMethod, deplo);
    assert.deepEqual(notes, []);
  }
});

test("mapBuildSettings falls back to nixpacks for the buildpack families, with a note", () => {
  for (const buildType of ["heroku_buildpacks", "paketo_buildpacks"] as const) {
    const { value, notes } = mapBuildSettings(app({ buildType }));
    assert.equal(value.buildMethod, "nixpacks");
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Set to Nixpacks/);
  }
});

test("mapBuildSettings carries the dockerfile settings and the build path", () => {
  const { value } = mapBuildSettings(
    app({
      buildType: "dockerfile",
      dockerfile: "docker/Dockerfile",
      dockerContextPath: "apps/web",
      dockerBuildStage: "runner",
      buildPath: "apps/web",
    }),
  );
  assert.equal(value.rootDirectory, "apps/web");
  assert.deepEqual(value.methodSettings, {
    dockerfilePath: "docker/Dockerfile",
    dockerContextPath: "apps/web",
    dockerBuildStage: "runner",
  });
});

test("mapBuildSettings sends publishDirectory to the field the builder reads", () => {
  const asStatic = mapBuildSettings(
    app({ buildType: "static", publishDirectory: "dist", isStaticSpa: true }),
  ).value;
  assert.equal(asStatic.outputDirectory, "dist");
  assert.equal(asStatic.methodSettings?.staticSinglePageApp, true);

  const asNixpacks = mapBuildSettings(
    app({ buildType: "nixpacks", publishDirectory: "public" }),
  ).value;
  assert.equal(asNixpacks.outputDirectory, undefined);
  assert.equal(asNixpacks.methodSettings?.nixpacksPublishDirectory, "public");
});

test("mapBuildSettings ignores the settings the chosen builder never reads", () => {
  // What a real Nixpacks app on Dokploy looks like: every build column is filled
  // in with that platform's defaults, and none of them are choices this app made.
  const { value } = mapBuildSettings(
    app({
      buildType: "nixpacks",
      dockerfile: "Dockerfile",
      dockerContextPath: ".",
      railpackVersion: "0.15.4",
    }),
  );
  assert.equal(value.buildMethod, "nixpacks");
  assert.equal(value.methodSettings, undefined);

  // The same values DO come across when they are the ones that build the app.
  assert.equal(
    mapBuildSettings(app({ buildType: "railpack", railpackVersion: "0.15.4" })).value
      .methodSettings?.railpackVersion,
    "0.15.4",
  );
});

test("mapBuildSettings notes replicas, which deplo does not scale", () => {
  const { notes } = mapBuildSettings(app({ replicas: 3 }));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /3 replicas/);
});

test("mapBuildSettings ignores a build path that is really the root", () => {
  for (const buildPath of ["/", "./", "  "])
    assert.equal(mapBuildSettings(app({ buildPath })).value.rootDirectory, undefined);
});

/* ---- resources ------------------------------------------------------ */

test("parseMemoryMb reads docker's suffixes and a bare byte count", () => {
  assert.equal(parseMemoryMb("512m"), 512);
  assert.equal(parseMemoryMb("1g"), 1024);
  assert.equal(parseMemoryMb("1.5Gi"), 1536);
  assert.equal(parseMemoryMb("2048k"), 2);
  assert.equal(parseMemoryMb("1073741824"), 1024);
  assert.equal(parseMemoryMb("nonsense"), null);
  assert.equal(parseMemoryMb("0"), null);
  assert.equal(parseMemoryMb(null), null);
});

test("parseCpuMilli splits cores from nano-CPUs", () => {
  assert.equal(parseCpuMilli("0.5"), 500);
  assert.equal(parseCpuMilli("2"), 2000);
  assert.equal(parseCpuMilli("500000000"), 500);
  assert.equal(parseCpuMilli("0.001"), null);
  assert.equal(parseCpuMilli(""), null);
});

test("mapResources returns null when Dokploy set no limits", () => {
  assert.deepEqual(mapResources({}), { value: null, notes: [] });
});

test("mapResources carries what it can and reports what it cannot", () => {
  const { value, notes } = mapResources({
    memoryLimit: "1g",
    memoryReservation: "256m",
    cpuLimit: "0.5",
    cpuReservation: "0.25",
  });
  assert.deepEqual(value, {
    memoryMb: 1024,
    memoryReservationMb: 256,
    cpuMilli: 500,
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /CPU reservation/);
});

test("mapResources drops a reservation above the limit rather than losing both", () => {
  const { value, notes } = mapResources({
    memoryLimit: "256m",
    memoryReservation: "1g",
  });
  assert.deepEqual(value, {
    memoryMb: 256,
    memoryReservationMb: null,
    cpuMilli: null,
  });
  assert.match(notes.join(" "), /above the limit/);
});

test("mapResources reports a limit it could not read", () => {
  const { notes } = mapResources({ memoryLimit: "loads" });
  assert.match(notes.join(" "), /set it by hand/);
});

/* ---- source --------------------------------------------------------- */

test("mapSource builds an https clone URL for every git flavour", () => {
  assert.deepEqual(cloneTarget(app()), {
    provider: "github",
    url: "https://github.com/acme/web.git",
    repo: "acme/web",
    branch: "main",
  });

  assert.deepEqual(
    cloneTarget(
      app({
        sourceType: "gitlab",
        gitlabPathNamespace: "acme/team",
        gitlabRepository: "api",
        gitlabBranch: "develop",
        gitlab: { gitlabUrl: "https://git.acme.com" },
      }),
    ),
    {
      provider: "gitlab",
      url: "https://git.acme.com/acme/team/api.git",
      repo: "acme/team/api",
      branch: "develop",
    },
  );

  assert.equal(
    cloneTarget(
      app({
        sourceType: "gitea",
        giteaOwner: "acme",
        giteaRepository: "svc",
        gitea: { giteaUrl: "code.acme.com" },
      }),
    )?.url,
    "https://code.acme.com/acme/svc.git",
  );

  assert.equal(
    cloneTarget(
      app({
        sourceType: "bitbucket",
        bitbucketOwner: "acme",
        bitbucketRepositorySlug: "thing",
      }),
    )?.url,
    "https://bitbucket.org/acme/thing.git",
  );

  assert.equal(
    cloneTarget(
      app({ sourceType: "git", customGitUrl: "https://git.example.com/a/b.git" }),
    )?.repo,
    "a/b",
  );
});

test("mapSource falls back to the public host when the provider row is absent", () => {
  assert.equal(
    cloneTarget(
      app({ sourceType: "gitlab", gitlabOwner: "acme", gitlabRepository: "api" }),
    )?.url,
    "https://gitlab.com/acme/api.git",
  );
});

test("mapSource always warns that no git credential came across", () => {
  const { value, notes } = mapSource(app());
  assert.equal(value.kind, "git");
  assert.match(notes.join(" "), /no credential/);
});

test("mapSource carries the git deploy options", () => {
  const { value } = mapSource(
    app({ triggerType: "tag", watchPaths: ["apps/web/**", "  "], enableSubmodules: true }),
  );
  assert.equal(value.kind, "git");
  if (value.kind !== "git") return;
  assert.equal(value.repo.triggerType, "tag");
  assert.deepEqual(value.repo.watchPaths, ["apps/web/**"]);
  assert.equal(value.repo.submodules, true);
});

test("mapSource takes a docker image and refuses one deplo would interpolate", () => {
  const ok = mapSource(app({ sourceType: "docker", dockerImage: "ghcr.io/acme/api:1.2" }));
  assert.deepEqual(ok.value, { kind: "docker-image", image: "ghcr.io/acme/api:1.2" });
  assert.deepEqual(ok.notes, []);

  const bad = mapSource(app({ sourceType: "docker", dockerImage: "acme/api:1 && rm -rf /" }));
  assert.deepEqual(bad.value, { kind: "none" });
  assert.match(bad.notes.join(" "), /not one Deplo accepts/);
});

test("mapSource reports a private registry, whose password never leaves Dokploy", () => {
  const { notes } = mapSource(
    app({ sourceType: "docker", dockerImage: "reg.acme.com/api:1", registryId: "reg-1" }),
  );
  assert.match(notes.join(" "), /private registry/);

  // The other half of the same setting: credentials typed onto the application
  // rather than picked from a registry entity. Same pull, same missing password,
  // and it used to come across looking like a public image.
  assert.match(
    mapSource(
      app({
        sourceType: "docker",
        dockerImage: "reg.acme.com/api:1",
        username: "robot",
        registryUrl: "reg.acme.com",
      }),
    ).notes.join(" "),
    /private registry/,
  );
});

test("mapSource flags an image that only exists on the source machine", () => {
  const { value, notes } = mapSource(
    app({ sourceType: "docker", dockerImage: "localhost:5000/database-fdo:1.0" }),
  );
  // Still imported - the reference is what the app is - but it cannot be pulled
  // from here, and "pull access denied" three days later points at the image
  // rather than at the migration.
  assert.deepEqual(value, {
    kind: "docker-image",
    image: "localhost:5000/database-fdo:1.0",
  });
  assert.match(notes.join(" "), /on the Dokploy machine/);
});

test("mapSource cannot import an uploaded archive", () => {
  const { value, notes } = mapSource(app({ sourceType: "drop" }));
  assert.deepEqual(value, { kind: "none" });
  assert.match(notes.join(" "), /Upload it again here/);
});

test("repoNameFromUrl handles https and scp-style remotes", () => {
  assert.equal(repoNameFromUrl("https://github.com/acme/web.git"), "acme/web");
  assert.equal(repoNameFromUrl("git@github.com:acme/web.git"), "acme/web");
  assert.equal(repoNameFromUrl("ssh://git@git.acme.com:2222/acme/web"), "acme/web");
});

/* ---- domains -------------------------------------------------------- */

test("isThrowawayHost only matches the generated hosts", () => {
  for (const host of ["app-abc.traefik.me", "1.2.3.4.sslip.io", "x.nip.io", "api.localhost"])
    assert.equal(isThrowawayHost(host), true, host);
  for (const host of ["acme.com", "api.acme.com", "traefik.mecca.com"])
    assert.equal(isThrowawayHost(host), false, host);
});

test("mapDomains keeps real hosts in order and drops the disposable ones", () => {
  const { value } = mapDomains(
    [
      { domainId: "1", host: "app-x.traefik.me", certificateType: "letsencrypt" },
      { domainId: "2", host: "Acme.com", port: 8080, certificateType: "letsencrypt" },
      { domainId: "3", host: "old.acme.com", enabled: false },
      { domainId: "4", host: "pr.acme.com", domainType: "preview" },
      { domainId: "5", host: "api.acme.com", path: "/api", stripPath: true, port: 3000 },
    ],
    { isCompose: false },
  );
  assert.deepEqual(
    value.map((d) => d.host),
    ["acme.com", "api.acme.com"],
  );
  assert.equal(value[0].port, 8080);
  assert.equal(value[0].certProvider, "letsencrypt");
  assert.equal(value[1].pathPrefix, "/api");
  assert.equal(value[1].stripPrefix, true);
});

test("mapDomains reports a custom certificate resolver it cannot carry", () => {
  const { value, notes } = mapDomains(
    [{ domainId: "1", host: "acme.com", certificateType: "custom" }],
    { isCompose: false },
  );
  assert.equal(value[0].certProvider, "none");
  assert.match(notes.join(" "), /custom certificate resolver/);
});

test("mapDomains keeps the compose service and needs a port there", () => {
  const { value, notes } = mapDomains(
    [{ domainId: "1", host: "acme.com", serviceName: "web" }],
    { isCompose: true },
  );
  assert.equal(value[0].service, "web");
  assert.match(notes.join(" "), /needs one for a compose stack/);
});

test("mapDomains routes plain http to the web entrypoint", () => {
  const { value } = mapDomains(
    [{ domainId: "1", host: "acme.com", https: false, certificateType: "none" }],
    { isCompose: false },
  );
  assert.equal(value[0].entrypoint, "web");
});

/* ---- mounts --------------------------------------------------------- */

test("volumeLabel produces the lowercase-kebab deplo requires", () => {
  assert.equal(volumeLabel("PG Data", "x"), "pg-data");
  assert.equal(volumeLabel("acme-app_data", "x"), "acme-app-data");
  assert.equal(volumeLabel("///", "fallback"), "fallback");
});

test("mapMounts splits the three Dokploy kinds into deplo's two writers", () => {
  const { value, notes } = mapMounts([
    {
      mountId: "1",
      type: "file",
      filePath: "./config.toml",
      content: "a = 1",
      mountPath: "/app/config.toml",
    },
    { mountId: "2", type: "volume", volumeName: "PG_DATA", mountPath: "/var/lib/data" },
    { mountId: "3", type: "bind", hostPath: "/srv/uploads", mountPath: "/uploads" },
  ]);
  assert.deepEqual(value.files, [{ filePath: "config.toml", content: "a = 1" }]);
  assert.deepEqual(value.volumes, [
    { type: "named", name: "pg-data", mountPath: "/var/lib/data", readOnly: false },
    {
      type: "host",
      name: "uploads",
      hostPath: "/srv/uploads",
      mountPath: "/uploads",
      readOnly: false,
    },
  ]);
  assert.deepEqual(notes, []);
});

test("mapMounts keeps two volumes with the same label apart", () => {
  const { value } = mapMounts([
    { mountId: "1", type: "volume", volumeName: "data", mountPath: "/a" },
    { mountId: "2", type: "volume", volumeName: "data", mountPath: "/b" },
  ]);
  assert.deepEqual(
    value.volumes.map((v) => v.name),
    ["data", "data-2"],
  );
});

test("mapMounts reports a mount it had to drop", () => {
  const { value, notes } = mapMounts([
    { mountId: "1", type: "bind", hostPath: "", mountPath: "/x" },
    { mountId: "2", type: "file", filePath: "", content: "x", mountPath: "/y" },
  ]);
  assert.deepEqual(value.volumes, []);
  assert.deepEqual(value.files, []);
  assert.equal(notes.length, 2);
});

/* ---- databases ------------------------------------------------------ */

function db(over: Partial<DokployDatabase> = {}): DokployDatabase {
  return {
    name: "main",
    appName: "acme-main-abc",
    dockerImage: "postgres:16",
    databaseName: "app",
    databaseUser: "app",
    databasePassword: "s3cret-value",
    ...over,
  };
}

test("imageTag reads the tag and ignores a registry port", () => {
  assert.equal(imageTag("postgres:16"), "16");
  assert.equal(imageTag("bitnami/postgresql:15.4"), "15.4");
  assert.equal(imageTag("reg.acme.com:5000/pg"), null);
  assert.equal(imageTag("reg.acme.com:5000/pg:14"), "14");
  assert.equal(imageTag("postgres"), null);
});

test("mapDatabase maps each engine deplo has and refuses libsql", () => {
  assert.equal(mapDatabase("postgres", db()).value?.type, "postgres");
  assert.equal(mapDatabase("mongo", db({ dockerImage: "mongo:7" })).value?.type, "mongodb");
  assert.equal(mapDatabase("redis", db({ dockerImage: "redis:7" })).value?.type, "redis");

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
  // The source image is pinned even when it is the canonical one: the data volume
  // is copied byte for byte, and only the binary that wrote a cluster can reopen
  // it faithfully (glibc and musl sort text differently).
  assert.equal(value?.customImage, "postgres:16");
});

test("mapDatabase pins the source image whatever shape the ref has", () => {
  const cases: [string, string, string][] = [
    // dockerImage, expected customImage, expected version
    ["postgres:18", "postgres:18", "18"],
    // a suffixed tag used to be re-suffixed into `postgres:16-alpine-alpine`
    ["postgres:16-alpine", "postgres:16-alpine", "16-alpine"],
    // no tag at all used to produce version "" and fail createDatabase; the ref
    // stays verbatim (it is what Dokploy runs) and the report warns about it
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
  // A canonical image is pinned too, but silently — there is nothing to warn about.
  assert.equal(mapDatabase("postgres", db()).notes.join(" ").includes("plain postgres"), false);
});

test("mapDatabase carries the external port and reports what a database cannot take", () => {
  const { value, notes } = mapDatabase(
    "postgres",
    db({
      externalPort: 5432,
      command: "postgres -c max_connections=200",
      mounts: [{ mountId: "1", type: "file", filePath: "extra.conf", mountPath: "/etc/x.conf" }],
    }),
  );
  assert.equal(value?.exposedPort, 5432);
  assert.match(notes.join(" "), /start command/);
  assert.match(notes.join(" "), /mounted on Dokploy/);
});

// Dokploy models a database's DATA volume as a mount row. Warning "extra files
// are not imported" about it fired on EVERY database and pointed at the one thing
// the Data step does copy.
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
  assert.equal(notes.join(" ").includes("mounted on Dokploy"), false, notes.join(" "));
});

/* ---- the data cutover ----------------------------------------------- */

test("sourceVolumesFrom keeps named volumes and drops bind mounts", () => {
  const volumes = sourceVolumesFrom({
    Mounts: [
      { Type: "volume", Name: "app_uploads", Destination: "/app/uploads/" },
      { Type: "bind", Source: "/srv/etc", Destination: "/etc/thing" },
      { Type: "volume", Name: "app_uploads", Destination: "/app/uploads" },
      { Type: "volume", Destination: "/anonymous" },
    ],
  });
  // Trailing slash normalised, the duplicate collapsed, the bind and the
  // anonymous mount left out - neither is something a data move can pair.
  assert.deepEqual(volumes, [{ name: "app_uploads", mountPath: "/app/uploads" }]);
});

test("pairVolumes matches on the container path, whatever either side calls them", () => {
  const { value, notes } = pairVolumes(
    [
      { name: "dok_uploads", mountPath: "/app/uploads" },
      { name: "dok_cache", mountPath: "/app/cache" },
    ],
    [
      { name: "deplo-web-cache", mountPath: "/app/cache" },
      { name: "deplo-web-uploads", mountPath: "/app/uploads" },
    ],
  );
  assert.deepEqual(
    value.map((p) => `${p.sourceVolume}->${p.targetVolume}@${p.mountPath}`),
    ["dok_uploads->deplo-web-uploads@/app/uploads", "dok_cache->deplo-web-cache@/app/cache"],
  );
  assert.deepEqual(notes, []);
});

test("pairVolumes reports both kinds of leftover", () => {
  const { value, notes } = pairVolumes(
    [{ name: "dok_data", mountPath: "/var/data" }],
    [{ name: "deplo-app-other", mountPath: "/srv/other" }],
  );
  assert.deepEqual(value, []);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /no volume of this app mounts that path/);
  assert.match(notes[1], /stays empty/);
});

test("pairVolumes pairs a database 1:1 even when the data dir moved", () => {
  const { value, notes } = pairVolumes(
    [{ name: "dok_pg", mountPath: "/var/lib/postgresql/18/docker" }],
    [{ name: "deplo-db-x_db-x-data", mountPath: "/var/lib/postgresql/data" }],
    { singleData: true },
  );
  assert.equal(value.length, 1);
  assert.equal(value[0].sourceVolume, "dok_pg");
  assert.match(value[0].note!, /data directory moved/);
  assert.match(value[0].note!, /pins the engine's data path/);
  assert.deepEqual(notes, []);
});

test("pairVolumes will not guess for an app, only for the single-data case", () => {
  const source = [{ name: "a", mountPath: "/one" }];
  const target = [{ name: "b", mountPath: "/two" }];
  assert.equal(pairVolumes(source, target).value.length, 0);
  assert.equal(pairVolumes(source, target, { singleData: true }).value.length, 1);
});

test("deploVolumeName knows which volumes carry an explicit name", () => {
  // A volume Deplo manages is rendered with `name:`, so compose uses it verbatim.
  assert.equal(deploVolumeName("web", "uploads", true), "deplo-web-uploads");
  // One declared in the user's own compose is prefixed by the project instead.
  assert.equal(deploVolumeName("web", "uploads", false), "deplo-web_uploads");
  assert.equal(deploDatabaseVolumeName("db-main"), "deplo-db-main_db-main-data");
});

test("composeVolumeMounts reads the named volumes and where they mount", () => {
  const compose = [
    "services:",
    "  web:",
    "    image: nginx",
    "    volumes:",
    "      - config:/etc/app",
    "      - /srv/host:/host",
    "      - ./rel:/rel",
    "  worker:",
    "    volumes:",
    "      - type: volume",
    "        source: data",
    "        target: /var/data/",
    "      - type: bind",
    "        source: /srv/x",
    "        target: /x",
    "volumes:",
    "  config: {}",
    "  data: {}",
  ].join("\n");
  assert.deepEqual(composeVolumeMounts(compose), [
    { name: "config", mountPath: "/etc/app" },
    { name: "data", mountPath: "/var/data" },
  ]);
});

test("composeVolumeMounts ignores a compose it cannot read", () => {
  assert.deepEqual(composeVolumeMounts("services:\n  web:\n   - : :"), []);
  assert.deepEqual(composeVolumeMounts(""), []);
});

/* ---- the rest ------------------------------------------------------- */

test("portNotes explains why published ports do not come across", () => {
  const notes = portNotes(
    app({
      ports: [
        { portId: "1", publishedPort: 8080, targetPort: 80, protocol: "tcp" },
      ],
    }),
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /8080->80\/tcp/);
  assert.deepEqual(portNotes(app()), []);
});

// A platform someone is leaving is usually STOPPED, and Dokploy stops a service
// by scaling its swarm service to 0 replicas: no container to inspect, while the
// volume sits untouched on the host. Reading what Dokploy declares is the only
// way that service's data moves at all.
test("declaredSourceVolumes reads a stopped service's volumes from its mounts", () => {
  const out = declaredSourceVolumes({
    kind: "postgres",
    appName: "test2-test-u9vb1j",
    mounts: [
      { type: "volume", volumeName: "test2-test-u9vb1j-data", mountPath: "/var/lib/postgresql/18/docker" },
      { type: "file", volumeName: null, mountPath: "/etc/thing.conf" },
      { type: "bind", volumeName: null, mountPath: "/srv/x" },
    ],
  });
  assert.deepEqual(out, [
    { name: "test2-test-u9vb1j-data", mountPath: "/var/lib/postgresql/18/docker" },
  ]);
});

test("declaredSourceVolumes prefixes a compose stack's volumes with its project", () => {
  const out = declaredSourceVolumes({
    kind: "compose",
    appName: "test-alltube-ab12",
    composeFile: [
      "services:",
      "  web:",
      "    volumes:",
      "      - data:/var/lib/app",
      "      - ./local:/etc/app",
      "volumes:",
      "  data:",
    ].join("\n"),
  });
  assert.deepEqual(out, [
    { name: "test-alltube-ab12_data", mountPath: "/var/lib/app" },
  ]);
});

test("declaredSourceVolumes has nothing to say about a service with no volumes", () => {
  assert.deepEqual(declaredSourceVolumes({ kind: "application", appName: "x" }), []);
});

// A Postgres 18 container on Dokploy reports TWO volumes: its data volume at
// /var/lib/postgresql/<major>/docker, and the anonymous one Docker creates for
// the image's own `VOLUME /var/lib/postgresql`, which the first is mounted
// inside of. Counting both made the source look like it had two data volumes, so
// pairVolumes' single-data rule (one per side) never fired and the imported
// database stayed empty.
test("sourceVolumesFrom drops the image's own parent mount", () => {
  const out = sourceVolumesFrom({
    Mounts: [
      {
        Type: "volume",
        Name: "svc-data",
        Destination: "/var/lib/postgresql/18/docker",
      },
      {
        Type: "volume",
        Name: "ff2ec11d77f7e019a1911e354db2112fc211fa2ce18a84529ce4a4ef272cc0d8",
        Destination: "/var/lib/postgresql",
      },
    ],
  });
  assert.deepEqual(out, [
    { name: "svc-data", mountPath: "/var/lib/postgresql/18/docker" },
  ]);
});

test("sourceVolumesFrom keeps siblings that merely share a prefix", () => {
  const out = sourceVolumesFrom({
    Mounts: [
      { Type: "volume", Name: "a", Destination: "/data/db" },
      { Type: "volume", Name: "b", Destination: "/data/dbx" },
    ],
  });
  assert.equal(out.length, 2);
});

test("pairVolumes stays quiet about an unmatched anonymous volume", () => {
  const { notes } = pairVolumes(
    [
      { name: "svc-data", mountPath: "/data/db" },
      {
        name: "935208427f4c92e7cd97bd69fa7bc26dbbc9c8898a6d801dea55ad1f69256f8b",
        mountPath: "/data/configdb",
      },
    ],
    [{ name: "deplo-db-x_db-x-data", mountPath: "/data/db" }],
  );
  assert.deepEqual(notes, []);
});

// mysql/mariadb carry two credentials on Dokploy and deplo models one, using it
// for BOTH the connection string and its own root-only operations (the backup
// dump, the console, rotation). A copied volume keeps the source's users, so the
// credential that has to come across is root's - otherwise every backup of an
// imported mysql fails with "access denied" long after the import looked fine.
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

test("mapDatabase leaves the application user alone when it IS root's password", () => {
  const { value, notes } = mapDatabase(
    "mysql",
    db({ databaseUser: "appuser", databasePassword: "same", databaseRootPassword: "same" }),
  );
  assert.equal(value?.username, "root");
  assert.equal(notes.join(" ").includes("Connects as root"), false);
});

test("mapDatabase keeps the application user for engines with a single credential", () => {
  const { value } = mapDatabase(
    "postgres",
    db({ databaseUser: "appuser", databasePassword: "app-pw", databaseRootPassword: "root-pw" }),
  );
  assert.equal(value?.username, "appuser");
  assert.equal(value?.password, "app-pw");
});
