import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../../yaml";
import {
  adaptComposeForDeplo,
  retargetPlatformEnvFiles,
} from "./compose-adapt";
import { COOLIFY_PLATFORM } from "./map-test-helpers";

test("adaptComposeForDeplo maps Dokploy's file mounts onto Deplo's convention", () => {
  // The platform writes the service's config next to the stack and the file binds it back in.
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
    "clickhouse_data:/var/lib/clickhouse",
    // Dokploy's files dir becomes Deplo's, so the imported file mounts line up with the compose that reads them.
    "./clickhouse_config:/etc/clickhouse-server/config.d",
    ".:/everything",
    // A real host path stays one, and goes on needing `canMountHostVolumes`.
    "/srv/real-host-path:/host",
    "../../elsewhere:/nope",
  ]);
  assert.deepEqual(doc.services.long.volumes, [
    { type: "bind", source: "./one.conf", target: "/etc/one.conf" },
  ]);
  assert.equal(changes.length, 3);
});

// `../files/x` is how Dokploy spells "a file next to this stack", and it appears in more than one place.
test("adaptComposeForDeplo rewrites ../files everywhere a compose names a file", () => {
  const { compose, changes } = adaptComposeForDeplo(`services:
  app:
    image: nginx
    env_file:
      - ../files/app.env
      - .env
    build:
      context: ../files/build
  worker:
    image: alpine
    env_file: ../files/worker.env
secrets:
  api_key:
    file: ../files/api_key.txt
configs:
  cfg:
    file: ../files/cfg.yml
`);
  const doc = yaml.load(compose) as {
    services: Record<
      string,
      { env_file?: unknown; build?: { context?: string } }
    >;
    secrets: Record<string, { file: string }>;
    configs: Record<string, { file: string }>;
  };
  assert.deepEqual(doc.services.app.env_file, ["./app.env", ".env"]);
  assert.equal(doc.services.app.build?.context, "./build");
  assert.equal(doc.services.worker.env_file, "./worker.env");
  assert.equal(doc.secrets.api_key.file, "./api_key.txt");
  assert.equal(doc.configs.cfg.file, "./cfg.yml");
  // Every rewrite is reported, and the platform's own `.env` is left alone: the agent writes one next to the stack.
  assert.equal(changes.filter((c) => c.includes("files directory")).length, 5);
});

test("adaptComposeForDeplo leaves a file reference that is not Dokploy's alone", () => {
  const source = `services:
  app:
    image: nginx
    env_file: ./config/app.env
secrets:
  k:
    file: /etc/secret
`;
  const { compose, changes } = adaptComposeForDeplo(source);
  assert.equal(compose, source);
  assert.deepEqual(changes, []);
});

// Every platform writes a service's variables into a file next to the compose, and they disagree on its name.
test("retargetPlatformEnvFiles points a foreign env file at Deplo's own", () => {
  const { compose, changes } = retargetPlatformEnvFiles(
    `services:
  web:
    image: nginx
    env_file: stack.env
  api:
    image: node
    env_file:
      - stack.env
      - ./config/app.env
`,
    ["config/app.env"],
  );
  const doc = yaml.load(compose) as {
    services: Record<string, { env_file?: unknown }>;
  };
  assert.equal(doc.services.web.env_file, "./.env");
  // The one the app CARRIES is left exactly as the author wrote it.
  assert.deepEqual(doc.services.api.env_file, ["./.env", "./config/app.env"]);
  assert.equal(changes.length, 2);
  assert.match(changes[0], /stack\.env/);
});

test("retargetPlatformEnvFiles leaves .env, a host path and a climb alone", () => {
  const source = `services:
  a:
    image: nginx
    env_file: .env
  b:
    image: nginx
    env_file: /etc/secrets/app.env
  c:
    image: nginx
    env_file: ../outside/app.env
`;
  const { compose, changes } = retargetPlatformEnvFiles(source, []);
  assert.equal(compose, source);
  assert.deepEqual(changes, []);
});

test("adaptComposeForDeplo rewrites a mount under the platform's data directory", () => {
  const source = [
    "services:",
    "  app:",
    "    image: nginx",
    "    volumes:",
    "      - /data/coolify/applications/ewc08w0/nginx.conf:/etc/nginx/nginx.conf",
  ].join("\n");

  const { compose } = adaptComposeForDeplo(source, COOLIFY_PLATFORM);
  const doc = yaml.load(compose) as {
    services: Record<string, { volumes: string[] }>;
  };
  assert.deepEqual(doc.services.app.volumes, [
    "./nginx.conf:/etc/nginx/nginx.conf",
  ]);
});

test("adaptComposeForDeplo strips the keys a panel's own compose dialect adds", () => {
  const source = `services:
  app:
    image: searxng/searxng
    exclude_from_hc: true
    volumes:
      - type: bind
        source: ./settings.yml
        target: /etc/searxng/settings.yml
        content: |
          use_default_settings: true
      - type: bind
        source: ./data
        target: /data
        is_directory: true
      - cache:/var/cache
volumes:
  cache: {}
`;
  const { compose, changes } = adaptComposeForDeplo(source);
  assert.doesNotMatch(compose, /exclude_from_hc|content:|is_directory/);
  assert.match(compose, /target: \/etc\/searxng\/settings\.yml/);
  assert.ok(changes.some((c) => /exclude_from_hc/.test(c)));
  assert.ok(changes.some((c) => /inline file key/.test(c)));
  assert.deepEqual(
    adaptComposeForDeplo("services:\n  a:\n    image: alpine\n").changes,
    [],
  );
});
