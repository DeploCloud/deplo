import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "js-yaml";

import {
  cloneTarget,
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
  stripDokployNetwork,
  volumeLabel,
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

test("stripDokployNetwork removes the declaration and every reference", () => {
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

  const { compose, changed } = stripDokployNetwork(source);
  assert.equal(changed, true);
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

test("stripDokployNetwork resolves the network by name, not by key", () => {
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

  const { compose, changed } = stripDokployNetwork(source);
  assert.equal(changed, true);
  const doc = yaml.load(compose) as {
    services: Record<string, { networks?: unknown }>;
    networks?: unknown;
  };
  assert.equal(doc.networks, undefined);
  assert.equal("networks" in doc.services.web, false);
});

test("stripDokployNetwork also reads the nested external.name form", () => {
  const source = [
    "services:",
    "  web:",
    "    image: nginx",
    "networks:",
    "  aliased:",
    "    external:",
    "      name: dokploy-network",
  ].join("\n");
  const { compose, changed } = stripDokployNetwork(source);
  assert.equal(changed, true);
  assert.equal((yaml.load(compose) as { networks?: unknown }).networks, undefined);
});

test("stripDokployNetwork leaves a clean compose byte-identical", () => {
  const source = "services:\n  web:\n    image: nginx # keep this comment\n";
  const { compose, changed } = stripDokployNetwork(source);
  assert.equal(changed, false);
  assert.equal(compose, source);
});

test("stripDokployNetwork does not throw on YAML it cannot parse", () => {
  const broken = "services:\n  web:\n   - : :";
  assert.deepEqual(stripDokployNetwork(broken), {
    compose: broken,
    changed: false,
  });
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
    assert.match(notes[0], /does not have/);
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
  assert.match(notes.join(" "), /not a value Deplo could read/);
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
  assert.match(notes.join(" "), /Registry passwords are not exposed/);
});

test("mapSource cannot import an uploaded archive", () => {
  const { value, notes } = mapSource(app({ sourceType: "drop" }));
  assert.deepEqual(value, { kind: "none" });
  assert.match(notes.join(" "), /Upload the archive again/);
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
  assert.equal(value?.customImage, null);
});

test("mapDatabase keeps a non-canonical image and says so", () => {
  const { value, notes } = mapDatabase(
    "postgres",
    db({ dockerImage: "pgvector/pgvector:pg16" }),
  );
  assert.equal(value?.customImage, "pgvector/pgvector:pg16");
  assert.equal(value?.version, "pg16");
  assert.match(notes.join(" "), /not a plain postgres/);
});

test("mapDatabase carries the external port and reports what a database cannot take", () => {
  const { value, notes } = mapDatabase(
    "postgres",
    db({
      externalPort: 5432,
      command: "postgres -c max_connections=200",
      mounts: [{ mountId: "1", type: "volume", volumeName: "extra", mountPath: "/x" }],
    }),
  );
  assert.equal(value?.exposedPort, 5432);
  assert.match(notes.join(" "), /custom start command/);
  assert.match(notes.join(" "), /takes no others/);
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
