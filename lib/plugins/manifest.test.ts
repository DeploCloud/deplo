import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PluginCatalogSchema,
  PluginManifestSchema,
  resolvePluginEnv,
  PlaceholderError,
  type PluginEnvVar,
} from "./manifest";

/* ------------------------------------------------------------------ */
/* Catalog / manifest validation                                       */
/* ------------------------------------------------------------------ */

test("catalog: a valid MCP listing parses and defaults tags/description", () => {
  const parsed = PluginCatalogSchema.safeParse([
    {
      id: "mcp",
      name: "AI MCP Server",
      version: "1.0.0",
      logo: "/apps/mcp/logo.svg",
      manifestUrl: "/apps/mcp/manifest.json",
    },
  ]);
  assert.ok(parsed.success);
  assert.equal(parsed.data[0].description, ""); // defaulted
  assert.deepEqual(parsed.data[0].tags, []); // defaulted
});

test("catalog: a non-slug app id is rejected", () => {
  const parsed = PluginCatalogSchema.safeParse([
    { id: "Bad Id!", name: "x", version: "1", manifestUrl: "/m.json" },
  ]);
  assert.equal(parsed.success, false);
});

test("manifest: a valid MCP manifest parses with one env placeholder", () => {
  const parsed = PluginManifestSchema.safeParse({
    id: "mcp",
    name: "AI MCP Server",
    version: "1.0.0",
    image: "devrepo.pixelfederico.com/mcp-server:1.0.0",
    expose: { port: 8080 },
    env: [{ key: "DEPLO_GRAPHQL_URL", value: "${deplo_graphql_url}" }],
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data.expose.port, 8080);
  assert.equal(parsed.data.env[0].key, "DEPLO_GRAPHQL_URL");
});

test("manifest: env with no env array defaults to []", () => {
  const parsed = PluginManifestSchema.safeParse({
    id: "mcp",
    name: "x",
    version: "1",
    image: "img:1",
    expose: { port: 80 },
  });
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data.env, []);
});

test("manifest: an out-of-range port is rejected", () => {
  const parsed = PluginManifestSchema.safeParse({
    id: "mcp",
    name: "x",
    version: "1",
    image: "img:1",
    expose: { port: 70000 },
  });
  assert.equal(parsed.success, false);
});

test("manifest: a bad env key (not a shell identifier) is rejected", () => {
  const parsed = PluginManifestSchema.safeParse({
    id: "mcp",
    name: "x",
    version: "1",
    image: "img:1",
    expose: { port: 80 },
    env: [{ key: "1BAD", value: "x" }],
  });
  assert.equal(parsed.success, false);
});

/* ------------------------------------------------------------------ */
/* Placeholder resolution                                              */
/* ------------------------------------------------------------------ */

const CTX = { deploGraphqlUrl: "https://deplo.example.com/api/graphql" };

test("resolvePluginEnv: substitutes ${deplo_graphql_url}", () => {
  const env: PluginEnvVar[] = [{ key: "DEPLO_GRAPHQL_URL", value: "${deplo_graphql_url}" }];
  assert.deepEqual(resolvePluginEnv(env, CTX), {
    DEPLO_GRAPHQL_URL: "https://deplo.example.com/api/graphql",
  });
});

test("resolvePluginEnv: a value with no placeholder passes through verbatim", () => {
  const env: PluginEnvVar[] = [{ key: "LOG_LEVEL", value: "info" }];
  assert.deepEqual(resolvePluginEnv(env, CTX), { LOG_LEVEL: "info" });
});

test("resolvePluginEnv: substitutes inside a larger string", () => {
  const env: PluginEnvVar[] = [{ key: "URL", value: "prefix-${deplo_graphql_url}-suffix" }];
  assert.equal(
    resolvePluginEnv(env, CTX).URL,
    "prefix-https://deplo.example.com/api/graphql-suffix",
  );
});

test("resolvePluginEnv: ${secret:N} yields a fresh token of the right rough length", () => {
  const env: PluginEnvVar[] = [{ key: "A", value: "${secret:16}" }];
  const a = resolvePluginEnv(env, CTX).A;
  const b = resolvePluginEnv(env, CTX).A;
  assert.notEqual(a, b); // fresh each call
  assert.ok(a.length >= 16); // base64url of 16 bytes is ~22 chars
  assert.ok(/^[A-Za-z0-9_-]+$/.test(a)); // url-safe
});

test("resolvePluginEnv: an unknown placeholder throws PlaceholderError", () => {
  const env: PluginEnvVar[] = [{ key: "X", value: "${not_a_thing}" }];
  assert.throws(() => resolvePluginEnv(env, CTX), PlaceholderError);
});

test("resolvePluginEnv: a malformed secret length throws PlaceholderError", () => {
  const env: PluginEnvVar[] = [{ key: "X", value: "${secret:0}" }];
  assert.throws(() => resolvePluginEnv(env, CTX), PlaceholderError);
  assert.throws(
    () => resolvePluginEnv([{ key: "X", value: "${secret:9999}" }], CTX),
    PlaceholderError,
  );
});
