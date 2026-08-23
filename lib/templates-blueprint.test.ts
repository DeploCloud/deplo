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

/**
 * Which entry gets the app's generated main domain. Document order decides it
 * for a template that says nothing (the case above), so the marker has to beat
 * that order — otherwise a stack's API sits on the URL the panel prints while
 * its web UI is the one hidden on a subdomain.
 */
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

  // The marked entry is hoisted, the rest keep document order, and every host
  // travels with its own entry. `primary = false` marks nothing, and a SECOND
  // marker does not take it off the first — an app has one main domain.
  assert.deepEqual(bp.exposes, [
    { service: "garage-webui", port: 3909, host: "web-ui.demo.example.com" },
    { service: "garage", port: 3900, host: "demo.example.com" },
    { service: "garage-admin", port: 3903, host: "admin.demo.example.com" },
  ]);
  assert.deepEqual(bp.expose, bp.exposes[0]);
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
