// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeRouteCandidates,
  declaredPort,
  detectDefaultApp,
} from "./compose-lint";

/**
 * Which service a compose stack's first domain points at. The old rule - first
 * service, port 80 - handed a whole analytics stack's address to its ClickHouse.
 */

const RYBBIT = `
services:
  rybbit_clickhouse:
    image: clickhouse/clickhouse-server:25.5
  rybbit_postgres:
    image: postgres:17.5
  rybbit_redis:
    image: redis:7-alpine
  rybbit_backend:
    image: ghcr.io/rybbit-io/rybbit-backend:v2.7.0
    depends_on:
      rybbit_clickhouse:
        condition: service_healthy
      rybbit_postgres:
        condition: service_started
  rybbit_client:
    image: ghcr.io/rybbit-io/rybbit-client:v2.7.0
    depends_on:
      - rybbit_backend
`;

test("detectDefaultApp routes the front door, not the database", () => {
  assert.deepEqual(detectDefaultApp(RYBBIT), {
    service: "rybbit_client",
    port: 80,
  });
});

test("detectDefaultApp reads a port a service only exposes", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  db:
    image: postgres:17
  app:
    image: acme/app
    expose:
      - "3001"
`),
    { service: "app", port: 3001 },
  );
});

test("detectDefaultApp keeps a datastore when there is nothing else", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  cache:
    image: redis:7-alpine
`),
    { service: "cache", port: 80 },
  );
});

test("detectDefaultApp: a published port beats the dependency graph", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  api:
    image: acme/api
    ports:
      - "8080:3000"
  web:
    image: acme/web
    depends_on:
      - api
`),
    { service: "api", port: 3000 },
  );
});

test("declaredPort: ports first, then expose, else nothing", () => {
  assert.equal(declaredPort({ ports: ["8080:80"], expose: ["3001"] }), 80);
  assert.equal(declaredPort({ expose: [3001] }), 3001);
  assert.equal(declaredPort({ ports: ["80/tcp"] }), 80);
  assert.equal(declaredPort({ image: "nginx" }), null);
});

test("composeRouteCandidates marks the primary, the databases and the reserved", () => {
  assert.deepEqual(
    composeRouteCandidates(`
services:
  postgres:
    image: postgres:17
  cache:
    image: redis:7
  web:
    image: nginx
`),
    [
      {
        name: "postgres",
        port: 80,
        isDatastore: true,
        isReserved: true,
        isPrimary: false,
      },
      {
        name: "cache",
        port: 80,
        isDatastore: true,
        isReserved: false,
        isPrimary: false,
      },
      {
        name: "web",
        port: 80,
        isDatastore: false,
        isReserved: false,
        isPrimary: true,
      },
    ],
  );
});

test("a fully-qualified image is still the database it is", () => {
  // Podman and pinned registries write the long form; the short check read it as
  // some unknown web image and handed it the app's address.
  assert.deepEqual(
    detectDefaultApp(`
services:
  db:
    image: docker.io/library/postgres:17
  app:
    image: acme/app
`),
    { service: "app", port: 80 },
  );
});

test("an image Deplo does not know is saved by the dependency graph", () => {
  // `bitnami/postgresql` is not one of the six repos, so the graph is what keeps
  // the address off it: the app waits on the database, nothing waits on the app.
  assert.deepEqual(
    detectDefaultApp(`
services:
  db:
    image: bitnami/postgresql:16
  app:
    image: acme/app
    depends_on:
      - db
`),
    { service: "app", port: 80 },
  );
});

test("a dependency cycle falls back to document order", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  a:
    image: acme/a
    depends_on: [b]
  b:
    image: acme/b
    depends_on: [a]
`),
    { service: "a", port: 80 },
  );
});

test("a service written with no body at all is still a candidate", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  web:
  db:
    image: postgres:17
`),
    { service: "web", port: 80 },
  );
});

test("declaredPort reads the long form and ignores a range it cannot resolve", () => {
  assert.equal(
    declaredPort({ ports: [{ target: 3000, published: 8080 }] }),
    3000,
  );
  assert.equal(declaredPort({ ports: ["127.0.0.1:8080:3000"] }), 3000);
  assert.equal(declaredPort({ expose: ["3000-3005"] }), null);
  assert.equal(declaredPort({ ports: { web: 80 } }), null);
});

test("with two published services, the one nothing waits on is the front door", () => {
  // A published port says "route here" for BOTH tiers, so document order is not
  // the tie-breaker: the API is written first, the UI is what a visitor wants.
  assert.deepEqual(
    detectDefaultApp(`
services:
  api:
    image: acme/api
    ports:
      - "8000:8000"
  web:
    image: acme/web
    ports:
      - "3000:3000"
    depends_on:
      - api
`),
    { service: "web", port: 3000 },
  );
});
