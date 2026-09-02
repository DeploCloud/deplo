import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyYamlScalar, languageForPath } from "./editor-language";

test("classifyYamlScalar reads numbers", () => {
  for (const n of [
    "3",
    "0",
    "-1.5e3",
    "+42",
    "1_000",
    ".5",
    "0x1f",
    "0o755",
    "0b1010",
    ".inf",
    "-.inf",
    ".NaN",
  ]) {
    assert.equal(classifyYamlScalar(n), "number", n);
  }
});

test("classifyYamlScalar reads booleans, null and the empty value", () => {
  for (const c of [
    "true",
    "false",
    "True",
    "FALSE",
    "yes",
    "no",
    "on",
    "off",
    "null",
    "~",
    "",
    "   ",
  ]) {
    assert.equal(classifyYamlScalar(c), "constant", JSON.stringify(c));
  }
});

test("classifyYamlScalar leaves everything else a string", () => {
  for (const s of [
    "nginx:1.27",
    "always",
    "unless-stopped",
    "/var/lib/postgresql/data",
    "1.2.3",
    "3000:3000",
    "truthy",
    "onwards",
    "-",
    "1e",
  ]) {
    assert.equal(classifyYamlScalar(s), "string", s);
  }
});

test("languageForPath only claims YAML", () => {
  assert.equal(languageForPath("docker-compose.yml"), "yaml");
  assert.equal(languageForPath("stack.YAML"), "yaml");
  assert.equal(languageForPath("/app/config/traefik.yaml"), "yaml");
  assert.equal(languageForPath("postgresql.conf"), null);
  assert.equal(languageForPath("config.xml"), null);
  assert.equal(languageForPath("init.sh"), null);
  assert.equal(languageForPath("yaml"), null);
  assert.equal(languageForPath(""), null);
  assert.equal(languageForPath(null), null);
  assert.equal(languageForPath(undefined), null);
});
