import { test } from "node:test";
import assert from "node:assert/strict";

import { getTemplateBlueprint } from "./templates-blueprint";

/**
 * The template.toml the catalog serves is remote input that ends up in a real
 * deploy, so the parser is what this covers: the env it injects, the service
 * Traefik is pointed at, and the invariant that a generated secret is the SAME
 * value in the env and in every mounted config file.
 */
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

  // Every publicly routed service, first one first — that is what `expose` is.
  assert.deepEqual(bp.exposes, [
    { service: "web", port: 8080, host: "demo.example.com" },
    { service: "api", port: 9000, host: "api.demo.example.com" },
  ]);
  assert.deepEqual(bp.expose, bp.exposes[0]);

  // The mount must carry the SAME generated secret the env got, or the stack
  // boots with a config file that disagrees with its own environment.
  assert.equal(bp.mounts.length, 1);
  assert.equal(bp.mounts[0].filePath, "app.conf");
  assert.equal(bp.mounts[0].content.trim(), `password = ${env.DB_PASSWORD}`);
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
