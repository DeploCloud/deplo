import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity } from "./identity-test-helpers";
import { seedApp, seedServer, SERVER_1 } from "./app-graph-test-helpers";
import type { AgentConnection } from "../infra/agent-client/connection";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { loadAppGraph } from "./app-graph-load";
import { adoptionsFor, keepUnnamedVolumes } from "./apps/unnamed-volumes";
import { keepOrigins } from "./apps/volumes";

const COMPOSE = `
services:
  fise-db:
    image: postgres:17
    volumes:
      - "./data/db:/var/lib/postgresql"
  web:
    image: ghcr.io/acme/web:1
`;

let db: TestDb;
let capabilities: string[] = [];

describe("an App's unnamed volumes become Volumes", () => {
  before(async () => {
    ({ db } = await makeTestDb());
    __setTestDb(db);
    await seedIdentity(db);
    await seedServer(db);
    __setAgentConnectorForTest(
      async () =>
        ({
          hello: async () => ({ capabilities }),
          close: () => {},
        }) as unknown as AgentConnection,
    );
  });
  after(() => {
    __setAgentConnectorForTest();
    __resetTestDb();
  });
  let n = 0;
  let id = "";
  beforeEach(async () => {
    capabilities = ["volumes.adopt"];
    id = `prj_fise${++n}`;
    await seedApp(db, {
      id,
      slug: `fise${n}`,
      source: "compose",
      compose: COMPOSE,
    });
  });

  const lookup = async (image: string) =>
    image === "postgres:17" ? ["/var/lib/postgresql/data"] : [];

  test("the image's volume is kept once, marked as the image's", async () => {
    const logs: string[] = [];
    const added = await keepUnnamedVolumes(
      id,
      SERVER_1,
      (m) => logs.push(m),
      lookup,
    );
    assert.equal(added.length, 1);
    const app = await loadAppGraph(id);
    assert.deepEqual(
      app?.volumes?.map((v) => [
        v.name,
        v.service,
        v.mountPath,
        v.origin,
        v.type ?? "named",
      ]),
      [
        [
          "fise-db-data",
          "fise-db",
          "/var/lib/postgresql/data",
          "image",
          "named",
        ],
      ],
    );
    assert.match(logs[0], /\/var\/lib\/postgresql\/data of fise-db/);
    assert.deepEqual(
      await keepUnnamedVolumes(id, SERVER_1, () => {}, lookup),
      [],
      "a second deploy adds nothing",
    );
  });

  test("an agent that cannot carry the data over gets nothing named", async () => {
    capabilities = [];
    assert.deepEqual(
      await keepUnnamedVolumes(id, SERVER_1, () => {}, lookup),
      [],
    );
    assert.equal((await loadAppGraph(id))?.volumes, null);
  });

  test("an unreadable registry names nothing and fails nothing", async () => {
    const added = await keepUnnamedVolumes(
      id,
      SERVER_1,
      () => {},
      async () => null,
    );
    assert.deepEqual(added, []);
  });

  test("the deploy tells the agent which mount to carry", async () => {
    await keepUnnamedVolumes(id, SERVER_1, () => {}, lookup);
    const rendered = `
services:
  fise-db:
    volumes:
      - fise-db-data:/var/lib/postgresql/data
volumes:
  fise-db-data:
    name: deplo-fise-fise-db-data
`;
    assert.deepEqual(await adoptionsFor(id, "fise", rendered), [
      {
        service: "fise-db",
        target: "/var/lib/postgresql/data",
        volume: "deplo-fise-fise-db-data",
      },
    ]);
  });

  test("saving Storage keeps the mark while the place is the same", () => {
    const had = [
      {
        id: "vol_1",
        name: "d",
        mountPath: "/d",
        readOnly: false,
        origin: "image" as const,
      },
    ];
    assert.equal(
      keepOrigins(
        [{ id: "vol_1", name: "d", mountPath: "/d", readOnly: true }],
        had,
      )?.[0].origin,
      "image",
    );
    assert.equal(
      keepOrigins(
        [{ id: "vol_1", name: "d", mountPath: "/e", readOnly: false }],
        had,
      )?.[0].origin,
      undefined,
    );
  });
});
