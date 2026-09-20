import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeRouteCandidates,
  declaredPort,
  composeRoutePort,
  detectDefaultApp,
} from "./compose-lint/routing";

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
    ports:
      - "3002:3000"
    depends_on:
      - rybbit_backend
`;

test("detectDefaultApp routes the front door, not the database", () => {
  assert.deepEqual(detectDefaultApp(RYBBIT), {
    service: "rybbit_client",
    port: 3000,
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

test("detectDefaultApp keeps a published datastore when there is nothing else", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  cache:
    image: redis:7-alpine
    ports:
      - "6379:6379"
`),
    { service: "cache", port: 6379 },
  );
});

test("a stack where nothing declares a port has no web service", () => {
  assert.equal(
    detectDefaultApp(`
services:
  worker:
    image: acme/worker
  db:
    image: postgres:17
`),
    null,
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
    ports:
      - "8080:80"
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
  assert.deepEqual(
    detectDefaultApp(`
services:
  db:
    image: docker.io/library/postgres:17
  app:
    image: acme/app
    expose:
      - "3000"
`),
    { service: "app", port: 3000 },
  );
});

test("an image Deplo does not know is saved by the dependency graph", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  db:
    image: bitnami/postgresql:16
    ports:
      - "5432:5432"
  app:
    image: acme/app
    ports:
      - "8080:3000"
    depends_on:
      - db
`),
    { service: "app", port: 3000 },
  );
});

test("a dependency cycle falls back to document order", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  a:
    image: acme/a
    ports:
      - "8000:8000"
    depends_on: [b]
  b:
    image: acme/b
    ports:
      - "9000:9000"
    depends_on: [a]
`),
    { service: "a", port: 8000 },
  );
});

test("a service written with no body at all declares no port", () => {
  assert.equal(
    detectDefaultApp(`
services:
  web:
  db:
    image: postgres:17
`),
    null,
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

test("composeRoutePort reads the port a service really answers on", () => {
  const compose = `
services:
  published:
    image: a
    ports:
      - "8080:3000"
  exposed:
    image: b
    expose:
      - "9000"
  checked:
    image: c
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5678/health"]
  silent:
    image: d
`;
  assert.equal(composeRoutePort(compose, "published"), 3000);
  assert.equal(composeRoutePort(compose, "exposed"), 9000);
  assert.equal(composeRoutePort(compose, "checked"), 5678);
  assert.equal(composeRoutePort(compose, "silent"), 80);
  assert.equal(composeRoutePort(compose, "absent"), null);
  assert.equal(composeRoutePort(null, "published"), null);
});
