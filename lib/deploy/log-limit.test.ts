import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as yaml from "js-yaml";

import { renderCompose } from "./build/compose-render";
import { buildComposeStack } from "./compose-stack/render";
import { generateDatabaseCompose } from "./database-compose";
import { defaultLogging } from "./resources";
import type { DatabaseType } from "../types/database";

type Doc = { services: Record<string, Record<string, unknown>> };
const CAP = {
  driver: "local",
  options: { "max-size": "20m", "max-file": "5" },
};

const stack = (compose: string) =>
  yaml.load(
    buildComposeStack({
      network: "deplo-team-team_test",
      compose,
      name: "deplo-demo",
      deployKey: "demo",
      appId: "p1",
      domainRoutes: [],
    }),
  ) as Doc;

describe("every container Deplo renders has a capped log", () => {
  test("the default is the local driver, 20m x 5", () => {
    assert.deepEqual(defaultLogging(), CAP);
    assert.notEqual(defaultLogging(), defaultLogging());
  });

  test("every service of a stack gets it, sidecars included", () => {
    const doc = stack(`services:
  web:
    image: nginx
  worker:
    image: busybox
  db:
    image: postgres:16
`);
    for (const name of ["web", "worker", "db"])
      assert.deepEqual(doc.services[name].logging, CAP, name);
  });

  test("a service's own logging is kept untouched", () => {
    const doc = stack(`services:
  web:
    image: nginx
    logging:
      driver: json-file
      options:
        max-size: 1g
  quiet:
    image: busybox
    logging:
      driver: none
  plain:
    image: busybox
    logging:
`);
    assert.deepEqual(doc.services.web.logging, {
      driver: "json-file",
      options: { "max-size": "1g" },
    });
    assert.deepEqual(doc.services.quiet.logging, { driver: "none" });
    assert.deepEqual(doc.services.plain.logging, CAP);
  });

  test("a single-image app gets it", () => {
    const doc = yaml.load(
      renderCompose({
        network: "deplo-team-team_test",
        name: "deplo-demo",
        image: "deplo/demo:abc",
        port: 3000,
        appId: "p1",
        deployKey: "demo",
        routes: [],
        env: {},
        resources: { memoryMb: 512 } as never,
      }),
    ) as Doc;
    const svc = doc.services["deplo-demo"];
    assert.deepEqual(svc.logging, CAP);
    assert.equal(svc.mem_limit, "512m");
  });

  for (const type of [
    "postgres",
    "mysql",
    "mariadb",
    "mongodb",
    "redis",
    "clickhouse",
  ] as DatabaseType[])
    test(`a managed ${type} database gets it`, () => {
      const doc = yaml.load(
        generateDatabaseCompose({
          name: "db-demo",
          databaseId: "db_test",
          type,
          version: "1",
          username: "app",
          password: "secret",
          dbName: "mydb",
          network: "deplo-team-team_test",
        }),
      ) as Doc;
      assert.deepEqual(doc.services["db-demo"].logging, CAP);
    });
});
