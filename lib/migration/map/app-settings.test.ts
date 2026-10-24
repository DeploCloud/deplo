import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_LOGO_STRING_LEN } from "../../apps/logo-shared";
import { mapBuildSettings, mapLogo, mapPorts } from "./app-settings";
import { app } from "./map-test-helpers";

test("mapBuildSettings keeps a Dockerfile, and lands every other builder on Railpack", () => {
  for (const [source, deplo] of [
    ["dockerfile", "dockerfile"],
    ["compose", "compose"],
    ["railpack", "railpack"],
    ["nixpacks", "railpack"],
    ["static", "railpack"],
    ["heroku_buildpacks", "railpack"],
    ["paketo_buildpacks", "railpack"],
  ] as const) {
    const { value, notes } = mapBuildSettings(app({ buildType: source }));
    assert.equal(value.buildMethod, deplo, source);
    assert.deepEqual(notes, []);
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

test("a folder the panel served arrives as Railpack's output directory", () => {
  const asStatic = mapBuildSettings(
    app({ buildType: "static", publishDirectory: "dist", isStaticSpa: true }),
  ).value;
  assert.equal(asStatic.buildMethod, "railpack");
  assert.equal(asStatic.outputDirectory, "dist");
  assert.equal(asStatic.methodSettings?.staticSinglePageApp, true);

  const asNixpacks = mapBuildSettings(
    app({ buildType: "nixpacks", publishDirectory: "public" }),
  ).value;
  assert.equal(asNixpacks.buildMethod, "railpack");
  assert.equal(asNixpacks.outputDirectory, "public");
  assert.equal(asNixpacks.methodSettings, undefined);
});

test("a publish directory a builder never read stays behind", () => {
  for (const buildType of [
    "railpack",
    "dockerfile",
    "heroku_buildpacks",
  ] as const) {
    const { value } = mapBuildSettings(
      app({ buildType, publishDirectory: "dist", isStaticSpa: true }),
    );
    assert.equal(value.outputDirectory, undefined, buildType);
    assert.equal(
      value.methodSettings?.staticSinglePageApp,
      undefined,
      buildType,
    );
  }
});

test("mapBuildSettings ignores the settings the chosen builder never reads", () => {
  const { value } = mapBuildSettings(
    app({
      buildType: "nixpacks",
      dockerfile: "Dockerfile",
      dockerContextPath: ".",
    }),
  );
  assert.equal(value.buildMethod, "railpack");
  assert.equal(value.methodSettings, undefined);
});

test("mapBuildSettings notes replicas, which Deplo does not scale", () => {
  const { notes } = mapBuildSettings(app({ replicas: 3 }));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /3 replicas/);
});

test("mapBuildSettings ignores a build path that is really the root", () => {
  for (const buildPath of ["/", "./", "  "])
    assert.equal(
      mapBuildSettings(app({ buildPath })).value.rootDirectory,
      undefined,
    );
});

test("mapPorts carries a published port across as it is", () => {
  const { value, notes } = mapPorts(
    app({
      ports: [
        {
          portId: "1",
          publishedPort: 16379,
          targetPort: 6379,
          protocol: "tcp",
        },
        {
          portId: "2",
          publishedPort: 25565,
          targetPort: 25565,
          protocol: "udp",
        },
      ],
    }),
  );
  assert.deepEqual(
    value.map((p) => `${p.published}:${p.target}/${p.protocol}`),
    ["16379:6379/tcp", "25565:25565/udp"],
  );
  assert.deepEqual(notes, []);
  assert.deepEqual(mapPorts(app()).value, []);
});

test("mapPorts refuses a privileged port and says what to do instead", () => {
  const { value, notes } = mapPorts(
    app({
      ports: [{ portId: "1", publishedPort: 80, targetPort: 80 }],
    }),
  );
  assert.deepEqual(value, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /80->80\/tcp/);
});

test("mapLogo carries a Dokploy icon across untouched", () => {
  const png = `data:image/png;base64,${Buffer.from("not really a png").toString("base64")}`;
  const svg = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  ).toString("base64")}`;
  assert.equal(mapLogo(png), png);
  assert.equal(mapLogo(svg), svg);
  assert.equal(mapLogo(`  ${png}  `), png);
});

test("mapLogo drops what Deplo would not store, and never throws", () => {
  assert.equal(mapLogo(null), null);
  assert.equal(mapLogo(undefined), null);
  assert.equal(mapLogo(""), null);
  assert.equal(mapLogo("   "), null);
  assert.equal(
    mapLogo("https://templates.dokploy.com/blueprints/n8n/logo.png"),
    null,
  );
  assert.equal(mapLogo("data:image/avif;base64,AAAA"), null);
  assert.equal(mapLogo("data:text/html;base64,PHNjcmlwdD4="), null);
  const huge = `data:image/png;base64,${"A".repeat(MAX_LOGO_STRING_LEN)}`;
  assert.equal(mapLogo(huge), null);
});

test("an image app's command is said, not stored where nothing reads it", () => {
  const image = mapBuildSettings(
    app({
      sourceType: "docker",
      dockerImage: "bitnami/redis",
      command: "redis-server --appendonly yes",
    }),
  );
  assert.equal(image.value.startCommand, undefined);
  assert.match(
    image.notes.join(" "),
    /Ran with the command "redis-server --appendonly yes"/,
  );
  const built = mapBuildSettings(
    app({ buildType: "nixpacks", command: "node server.js" }),
  );
  assert.equal(built.value.startCommand, "node server.js");
});

test("the panel's build-step overrides reach the build settings", () => {
  const { value } = mapBuildSettings(
    app({
      buildType: "nixpacks",
      installCommand: "pnpm i",
      buildCommand: "pnpm build",
    }),
  );
  assert.equal(value.installCommand, "pnpm i");
  assert.equal(value.buildCommand, "pnpm build");
});
