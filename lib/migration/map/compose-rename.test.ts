import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../../yaml";
import { renameClashingServices } from "./compose-rename";

test("renameClashingServices moves a taken service name and its references", () => {
  const source = [
    "services:",
    "  docmost:",
    "    image: docmost/docmost",
    "    depends_on:",
    "      - db",
    "      - redis",
    "    environment:",
    "      DATABASE_URL: postgresql://u:p@db:5432/docmost",
    "      REDIS_URL: redis://redis:6379",
    "      DB_HOST: db",
    "  db:",
    "    image: postgres:16-alpine",
    "    environment:",
    "      POSTGRES_DB: postgres",
    "  redis:",
    "    image: redis:7-alpine",
  ].join("\n");

  const { compose, renames, changes } = renameClashingServices(
    source,
    new Set(["db", "redis"]),
    "b5-docmost",
  );
  const doc = yaml.load(compose) as {
    services: Record<
      string,
      { depends_on?: string[]; environment?: Record<string, string> }
    >;
  };
  assert.deepEqual(Object.keys(doc.services), [
    "docmost",
    "b5-docmost-db",
    "b5-docmost-redis",
  ]);
  assert.deepEqual(doc.services.docmost.depends_on, [
    "b5-docmost-db",
    "b5-docmost-redis",
  ]);
  assert.equal(
    doc.services.docmost.environment!.DATABASE_URL,
    "postgresql://u:p@b5-docmost-db:5432/docmost",
  );
  assert.equal(
    doc.services.docmost.environment!.REDIS_URL,
    "redis://b5-docmost-redis:6379",
  );
  assert.equal(doc.services.docmost.environment!.DB_HOST, "b5-docmost-db");
  // A database NAME that happens to spell a service is not a hostname.
  assert.equal(
    doc.services["b5-docmost-db"].environment!.POSTGRES_DB,
    "postgres",
  );
  assert.equal(renames.get("db"), "b5-docmost-db");
  assert.equal(changes.length, 2);
});

test("renameClashingServices numbers a taken name like a slug when given no prefix", () => {
  const source = [
    "services:",
    "  web:",
    "    image: nginx",
    "    depends_on:",
    "      - db",
    "  db:",
    "    image: postgres:16",
  ].join("\n");
  const { compose, renames } = renameClashingServices(
    source,
    new Set(["db", "db-2"]),
    null,
  );
  const doc = yaml.load(compose) as {
    services: Record<string, { depends_on?: string[] }>;
  };
  assert.deepEqual(Object.keys(doc.services), ["web", "db-3"]);
  assert.deepEqual(doc.services.web.depends_on, ["db-3"]);
  assert.equal(renames.get("db"), "db-3");
});

test("renameClashingServices leaves a stack nothing contests alone", () => {
  const source = ["services:", "  db:", "    image: postgres:16"].join("\n");
  const { compose, renames } = renameClashingServices(
    source,
    new Set(["other"]),
    "mine",
  );
  assert.equal(compose, source);
  assert.equal(renames.size, 0);
});

test("renameClashingServices moves a taken `hostname:` too", () => {
  const source = [
    "services:",
    "  api:",
    "    image: nginx",
    "    hostname: cache",
    "  worker:",
    "    image: nginx",
    "    environment:",
    "      CACHE_HOST: cache",
  ].join("\n");
  const { compose } = renameClashingServices(
    source,
    new Set(["cache"]),
    "myapp",
  );
  const doc = yaml.load(compose) as {
    services: Record<
      string,
      { hostname?: string; environment?: Record<string, string> }
    >;
  };
  assert.equal(doc.services.api.hostname, "myapp-cache");
  assert.equal(doc.services.worker.environment!.CACHE_HOST, "myapp-cache");
});

test("a rename carries a DBHOST-style reference with it", () => {
  // Measured in production: a rename that left `PAPERLESS_DBHOST: db` behind spent 106 restarts on a NEIGHBOUR's database.
  const out = renameClashingServices(
    [
      "services:",
      "  db:",
      "    image: postgres:16",
      "  webserver:",
      "    image: paperless",
      "    environment:",
      "      PAPERLESS_DBHOST: db",
      "      PAPERLESS_REDIS: 'redis://broker:6379'",
    ].join("\n"),
    new Set(["db"]),
    "b4-paperless",
  );
  assert.equal(out.renames.get("db"), "b4-paperless-db");
  assert.match(out.compose, /PAPERLESS_DBHOST: b4-paperless-db/);
  // Untouched: it names a service that was not renamed.
  assert.match(out.compose, /redis:\/\/broker:6379/);
});

test("a key that merely ENDS in host is not a hostname", () => {
  // `GHOST` is an application, not a host: renaming its value would be a silent edit to somebody's config.
  const out = renameClashingServices(
    "services:\n  db:\n    image: p\n  app:\n    image: a\n    environment:\n      GHOST: db\n",
    new Set(["db"]),
    "blog",
  );
  assert.match(out.compose, /GHOST: db/);
});
