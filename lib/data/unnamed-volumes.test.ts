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
  test("what an image Deplo built declares is kept once, as the image's, from its first deploy", async () => {
    const built = `prj_built${n}`;
    await seedApp(db, {
      id: built,
      slug: `built${n}`,
      source: "github",
      compose: null,
    });
    const added = await keepUnnamedVolumes(
      built,
      SERVER_1,
      () => {},
      async () => [],
      ["/data"],
    );
    assert.deepEqual(
      added.map((v) => [v.name, v.service ?? null, v.mountPath, v.origin]),
      [["data", null, "/data", "image"]],
    );
    assert.deepEqual(
      await keepUnnamedVolumes(
        built,
        SERVER_1,
        () => {},
        async () => [],
        ["/data"],
      ),
      [],
      "the next build adds nothing",
    );
  });

  test("a private image is read with the team's login for its registry", async () => {
    const { registries } =
      await import("../db/schema/control-plane/integrations");
    const { encryptSecret } = await import("../crypto");
    const { __setDnsLookupForTest, __resetDnsLookupForTest } =
      await import("../outbound-url");
    const app = await loadAppGraph(id);
    await db.insert(registries).values({
      id: `reg_${n}`,
      teamId: app!.teamId,
      name: "acme",
      type: "ghcr",
      registryUrl: "ghcr.io",
      username: "acme-bot",
      passwordEnc: encryptSecret("p4ss"),
      createdAt: new Date().toISOString(),
    });
    __setDnsLookupForTest(async () => [{ address: "140.82.112.33" }]);
    const origFetch = globalThis.fetch;
    const basic = `Basic ${Buffer.from("acme-bot:p4ss").toString("base64")}`;
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      asked.push(`${url} ${auth.split(" ")[0]}`);
      if (url === "https://ghcr.io/v2/")
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
          },
        });
      if (url.startsWith("https://ghcr.io/token"))
        return auth === basic
          ? Response.json({ token: "t0k" })
          : new Response("", { status: 401 });
      if (url.includes("/manifests/"))
        return auth === "Bearer t0k"
          ? Response.json({ config: { digest: "sha256:abc" } })
          : new Response("", { status: 401 });
      if (url.includes("/blobs/"))
        return Response.json({ config: { Volumes: { "/srv/uploads": {} } } });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const added = await keepUnnamedVolumes(id, SERVER_1, () => {});
      const web = added.find((v) => v.service === "web");
      assert.equal(web?.mountPath, "/srv/uploads", asked.join("\n"));
      assert.equal(web?.origin, "image");
    } finally {
      globalThis.fetch = origFetch;
      __resetDnsLookupForTest();
    }
  });
});
