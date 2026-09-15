import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coolifyApplication,
  coolifyFallbackPort,
  coolifyPorts,
} from "./applications";
import { APP } from "./map-test-helpers";

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

test("an application whose address stands on its own arrives as plain git", () => {
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

test("an application carries the port it listens on", () => {
  assert.equal(coolifyApplication(APP).routingPort, 3000);
  assert.equal(
    coolifyApplication({ ...APP, ports_exposes: "" }).routingPort,
    null,
  );
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
