import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeDeclaredEnvKeys,
  composeEnvValues,
  detectDefaultApp,
  escapeComposeDollars,
} from "./compose-read";
import { WEB_API_COMPOSE } from "./stack-test-helpers";

test("detectDefaultApp prefers a service that publishes a port", () => {
  assert.deepEqual(detectDefaultApp(WEB_API_COMPOSE), {
    service: "web",
    port: 80,
  });
});

test("detectDefaultApp falls back to the first service on port 80", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  only:
    image: nginx
`),
    { service: "only", port: 80 },
  );
});

test("detectDefaultApp skips a service named after Deplo's own network names", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  postgres:
    image: postgres:16
  web:
    image: nginx
`),
    { service: "web", port: 80 },
  );
  assert.equal(
    detectDefaultApp(`
services:
  traefik:
    image: traefik:v3
    ports:
      - "80:80"
`),
    null,
  );
});

test("detectDefaultApp is null for empty / unparseable compose", () => {
  assert.equal(detectDefaultApp(null), null);
  assert.equal(detectDefaultApp(""), null);
  assert.equal(detectDefaultApp("services: [this is not valid"), null);
});

test("composeDeclaredEnvKeys names the keys the authored YAML sets itself", () => {
  assert.deepEqual(
    composeDeclaredEnvKeys(
      [
        "services:",
        "  web:",
        "    environment:",
        "      - SET=1",
        "      - PASSTHROUGH",
        "  api:",
        "    environment:",
        "      MAPPED: x",
        "      BARE:",
      ].join("\n"),
    ).sort(),
    ["MAPPED", "SET"],
  );
  assert.deepEqual(composeDeclaredEnvKeys(null), []);
  assert.deepEqual(composeDeclaredEnvKeys("not: [valid"), []);
});

test("escapeComposeDollars doubles a $ and leaves everything else alone", () => {
  assert.equal(escapeComposeDollars('"plain"'), '"plain"');
  assert.equal(escapeComposeDollars('"a$b"'), '"a$$b"');
  assert.equal(escapeComposeDollars('"${X}"'), '"$${X}"');
});

test("composeEnvValues reads what the compose sets itself, both shapes", () => {
  const list = composeEnvValues(
    "services:\n  a:\n    environment:\n      - DATABASE_URL=postgres://db-shop:5432/x\n",
  );
  assert.equal(list.DATABASE_URL, "postgres://db-shop:5432/x");
  const map = composeEnvValues(
    "services:\n  a:\n    environment:\n      DB_HOST: db-shop\n",
  );
  assert.equal(map.DB_HOST, "db-shop");
});
