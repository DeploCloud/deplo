import { test } from "node:test";
import assert from "node:assert/strict";

import { getTemplateBlueprint } from "./templates-blueprint";

const CONFIG = `
[variables]
main_domain = "\${domain}"
db_password = "\${password:24}"

[config]
[config.env]
APP_URL = "https://\${main_domain}"
DB_PASSWORD = "\${db_password}"

[[config.domains]]
serviceName = "web"
port = 8080
host = "\${main_domain}"

[[config.domains]]
serviceName = "api"
port = 9000
host = "api.\${main_domain}"

[[config.mounts]]
filePath = "app.conf"
content = """
password = \${db_password}
"""
`;

const template = {
  slug: "demo-app",
  compose: "services:\n  web:\n    image: demo\n",
  config: CONFIG,
};

test("resolves env, domains and mounts from a template's config", () => {
  const bp = getTemplateBlueprint(template, { domain: "demo.example.com" });

  assert.equal(bp.compose, template.compose);

  const env = Object.fromEntries(bp.env.map((e) => [e.key, e.value]));
  assert.equal(env.APP_URL, "https://demo.example.com");
  assert.match(env.DB_PASSWORD, /^.{24}$/);

  assert.deepEqual(bp.exposes, [
    { service: "web", port: 8080, host: "demo.example.com" },
    { service: "api", port: 9000, host: "api.demo.example.com" },
  ]);
  assert.deepEqual(bp.expose, bp.exposes[0]);

  assert.equal(bp.mounts.length, 1);
  assert.equal(bp.mounts[0].filePath, "app.conf");
  assert.equal(bp.mounts[0].content.trim(), `password = ${env.DB_PASSWORD}`);
});

const PRIMARY_CONFIG = `
[variables]
main_domain = "\${domain}"

[config]
[config.env]
APP_URL = "https://\${main_domain}"

[[config.domains]]
serviceName = "garage"
port = 3900
host = "\${main_domain}"
primary = false

[[config.domains]]
serviceName = "garage-webui"
port = 3909
host = "web-ui.\${main_domain}"
primary = true

[[config.domains]]
serviceName = "garage-admin"
port = 3903
host = "admin.\${main_domain}"
primary = true
`;

test("an explicitly marked primary wins over document order", () => {
  const bp = getTemplateBlueprint(
    { slug: "garage-s3", compose: "services: {}\n", config: PRIMARY_CONFIG },
    { domain: "demo.example.com" },
  );

  assert.deepEqual(bp.exposes, [
    { service: "garage-webui", port: 3909, host: "web-ui.demo.example.com" },
    { service: "garage", port: 3900, host: "demo.example.com" },
    { service: "garage-admin", port: 3903, host: "admin.demo.example.com" },
  ]);
  assert.deepEqual(bp.expose, bp.exposes[0]);
});

const PATH_CONFIG = `
[variables]
main_domain = "\${domain}"

[config]
[config.env]
BASE_URL = "https://\${main_domain}"

[[config.domains]]
serviceName = "client"
port = 3002
host = "\${main_domain}"

[[config.domains]]
serviceName = "backend"
port = 3001
host = "\${main_domain}"
path = "/api"

[[config.domains]]
serviceName = "admin"
port = 3003
`;

test("a domain entry carries its path, and one without a host survives", () => {
  const bp = getTemplateBlueprint(
    { slug: "split", compose: "services: {}\n", config: PATH_CONFIG },
    { domain: "demo.example.com" },
  );

  assert.deepEqual(bp.exposes, [
    { service: "client", port: 3002, host: "demo.example.com" },
    { service: "backend", port: 3001, host: "demo.example.com", path: "/api" },
    { service: "admin", port: 3003, host: undefined },
  ]);
});

test("a template with no config still deploys its compose", () => {
  const bp = getTemplateBlueprint({ slug: "bare", compose: "x", config: "" });
  assert.deepEqual(bp, {
    compose: "x",
    env: [],
    expose: null,
    exposes: [],
    mounts: [],
  });
});
