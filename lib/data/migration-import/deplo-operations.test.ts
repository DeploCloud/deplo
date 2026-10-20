import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { decryptSecret } from "../../crypto";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  gitConnections,
  registries,
} from "../../db/schema/control-plane/integrations";
import type {
  DeploExportApp,
  DeploExportGitConnection,
} from "../../migration/deplo/export-shape";
import {
  __resetDnsLookupForTest,
  __setDnsLookupForTest,
} from "../../outbound-url";
import {
  deploExport,
  exportApp,
} from "../../migration/deplo/deplo-test-helpers";
import {
  closeMigrationHarness,
  openMigrationHarness,
  provisionServer1,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import {
  blockingLines,
  fakeDeplo,
  importDeploProject,
  importFromDeplo,
  reportLines,
} from "./deplo-import-test-helpers";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
  __setDnsLookupForTest(async () => [{ address: "93.184.216.34" }]);
});

after(async () => {
  __resetDnsLookupForTest();
  await closeMigrationHarness(db, pg);
});

beforeEach(async () => {
  await resetMigrationHarness(db);
  await provisionServer1(db);
  await db.execute("truncate table git_connections, registries cascade;");
});

const landed = async (name: string) =>
  (await db.select().from(appsTable)).find((a) => a.name === name)!;

const stack = (over: Partial<DeploExportApp> = {}) =>
  exportApp({
    id: "prj_stack",
    name: "stack",
    slug: "stack",
    source: "compose",
    repo: null,
    compose: "services:\n  web:\n    image: nginx:1.27\n",
    ...over,
  });

test("a stack lands with its compose flags, rollback count and deploy hook as they were", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        stack({
          composeUpArgs: "--remove-orphans --wait",
          rollbackKeep: 9,
          deployHook: { enabled: false, used: false },
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );

  const app = await landed("stack");
  assert.equal(app.composeUpArgs, "--remove-orphans --wait");
  assert.equal(app.rollbackKeep, 9);
  assert.equal(app.deployHookEnabled, false);
  const lines = (await reportLines(runId)).join(" | ");
  assert.doesNotMatch(lines, /too old to hand over its compose flags/);
  assert.doesNotMatch(lines, /deploy hook/i);
});

test("a deploy hook somebody called says its address changed, without blocking the app", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        stack({
          composeUpArgs: null,
          rollbackKeep: 3,
          deployHook: { enabled: true, used: true },
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );

  assert.equal((await landed("stack")).deployHookEnabled, true);
  assert.match(
    (await reportLines(runId)).join(" | "),
    /deploy hook has a new address here/,
  );
  assert.doesNotMatch((await blockingLines(runId)).join(" | "), /deploy hook/);
});

test("a Deplo too old to send them says the deploy settings start at the defaults", async () => {
  const runId = await importFromDeplo(
    deploExport({ apps: [stack()], databases: [] }),
    ["prc_shop"],
  );

  const app = await landed("stack");
  assert.equal(app.composeUpArgs, null);
  assert.equal(app.rollbackKeep, 3);
  assert.match(
    (await reportLines(runId)).join(" | "),
    /too old to hand over its compose flags, rollback count and deploy hook/,
  );
});

const ACME_GIT: DeploExportGitConnection = {
  id: "gitc_src",
  provider: "git",
  label: "Acme git",
  baseUrl: "https://git.acme.com",
  allowPrivateEndpoint: false,
  username: "deploy",
  token: "s3cret-token",
};

const fromGit = (over: Partial<DeploExportApp> = {}) =>
  exportApp({
    source: "git",
    repo: {
      provider: "git",
      url: "https://git.acme.com/acme/web.git",
      repo: "acme/web",
      branch: "main",
      connectionId: "gitc_src",
    },
    ...over,
  });

test("an app cloned through a git connection lands with that connection, token and all", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [fromGit(), fromGit({ id: "prj_api", name: "api", slug: "api" })],
      databases: [],
      gitConnections: [ACME_GIT],
    }),
    ["prc_shop"],
  );

  const conns = await db.select().from(gitConnections);
  assert.equal(conns.length, 1, "both apps share the one connection");
  assert.equal(conns[0]!.label, "Acme git");
  assert.equal(conns[0]!.baseUrl, "https://git.acme.com");
  assert.equal(decryptSecret(conns[0]!.tokenEnc), "s3cret-token");
  for (const name of ["web", "api"])
    assert.equal((await landed(name)).repoConnectionId, conns[0]!.id);
  const lines = (await reportLines(runId)).join(" | ");
  assert.doesNotMatch(lines, /s3cret-token/);
  assert.doesNotMatch(lines, /no credential came with it/);
  assert.equal((await blockingLines(runId)).length, 0);
  assert.match(lines, /webhook/);
});

test("a git token the old Deplo would not reveal leaves the app asking for a connection", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [fromGit()],
      databases: [],
      gitConnections: [{ ...ACME_GIT, token: null }],
    }),
    ["prc_shop"],
  );

  assert.equal((await db.select().from(gitConnections)).length, 0);
  assert.equal((await landed("web")).repoConnectionId, null);
  assert.match(
    (await blockingLines(runId)).join(" | "),
    /Acme git git connection/,
  );
});

test("a git connection this Deplo refuses blocks the app with the reason", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [fromGit()],
      databases: [],
      gitConnections: [
        { ...ACME_GIT, baseUrl: "https://user:pw@git.acme.com" },
      ],
    }),
    ["prc_shop"],
  );

  assert.equal((await landed("web")).repoConnectionId, null);
  assert.match(
    (await blockingLines(runId)).join(" | "),
    /Acme git git connection did not come across \(Put the token in the token field/,
  );
});

test("a Deplo too old to send its git connections says the app needs one attached", async () => {
  const runId = await importFromDeplo(
    deploExport({ apps: [fromGit()], databases: [] }),
    ["prc_shop"],
  );

  assert.equal((await landed("web")).repoConnectionId, null);
  assert.match(
    (await blockingLines(runId)).join(" | "),
    /too old to hand over the git connection acme\/web clones with/,
  );
});

test("a repository cloned through the GitHub App says the app must be linked again", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          repo: {
            provider: "github",
            url: "https://github.com/acme/web.git",
            repo: "acme/web",
            branch: "main",
            installationId: "ghi_src",
          },
        }),
      ],
      databases: [],
      gitConnections: [],
    }),
    ["prc_shop"],
  );

  assert.match(
    (await blockingLines(runId)).join(" | "),
    /through the GitHub App on .*, which cannot move/,
  );
  assert.doesNotMatch(
    (await reportLines(runId)).join(" | "),
    /no credential came with it/,
  );
});

const ACME_REGISTRY = {
  name: "Acme images",
  type: "generic",
  registryUrl: "registry.acme.com",
  username: "ci",
  password: "reg-password",
};

const fromImage = (image: string) =>
  exportApp({
    id: "prj_img",
    name: "img",
    slug: "img",
    source: "docker-image",
    repo: null,
    dockerImage: image,
  });

test("the team's registries land with their passwords, so private images still pull", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [fromImage("registry.acme.com/acme/api:1.4")],
      databases: [],
      registries: [ACME_REGISTRY],
    }),
    ["prc_shop"],
  );

  const rows = await db.select().from(registries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.registryUrl, "registry.acme.com");
  assert.equal(decryptSecret(rows[0]!.passwordEnc), "reg-password");
  const lines = (await reportLines(runId)).join(" | ");
  assert.doesNotMatch(lines, /reg-password/);
  assert.doesNotMatch(lines, /If that image is private/);
  assert.equal((await blockingLines(runId)).length, 0);
});

test("a registry already here is kept, not added twice", async () => {
  const x = deploExport({
    apps: [fromImage("registry.acme.com/acme/api:1.4")],
    databases: [],
    registries: [ACME_REGISTRY],
  });
  await importFromDeplo(x, ["prc_shop"]);
  await importFromDeplo(x, ["prc_shop"]);
  assert.equal((await db.select().from(registries)).length, 1);
});

test("a registry password the old Deplo would not reveal blocks what pulls from it", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [fromImage("registry.acme.com/acme/api:1.4")],
      databases: [],
      registries: [{ ...ACME_REGISTRY, password: null }],
    }),
    ["prc_shop"],
  );

  assert.equal((await db.select().from(registries)).length, 0);
  assert.match(
    (await blockingLines(runId)).join(" | "),
    /Acme images.*Add it under Registries/,
  );
});

// Every registry answers the manifest with this status: 404 is "no such image".
function registryAnswering(status = 404): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v2/")) return new Response("{}", { status: 200 });
    if (url.includes("/manifests/")) return new Response("", { status });
    return real(input);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

function targetAgent() {
  const loaded: { server: string; ref: string; bytes: string }[] = [];
  __setAgentConnectorForTest(
    async (server) =>
      ({
        importImage: async (ref: string, chunks: AsyncIterable<Buffer>) => {
          const parts: Buffer[] = [];
          for await (const c of chunks) parts.push(c);
          loaded.push({ server, ref, bytes: Buffer.concat(parts).toString() });
          return { ok: true, error: "", bytesWritten: 1 };
        },
        close() {},
      }) as unknown as AgentConnection,
  );
  return loaded;
}

test("an image that exists only on the old server is copied to the app's server here", async () => {
  const restore = registryAnswering();
  try {
    const loaded = targetAgent();
    const source = fakeDeplo(
      deploExport({ apps: [fromImage("acme-api:local")], databases: [] }),
      (body) =>
        body.image === "acme-api:local" && body.id === "prj_img"
          ? new Response("image-bytes", { status: 200 })
          : new Response("not found", { status: 404 }),
    );
    const runId = await importDeploProject("prc_shop");

    const app = await landed("img");
    assert.deepEqual(loaded, [
      { server: app.serverId, ref: "acme-api:local", bytes: "image-bytes" },
    ]);
    assert.ok(source.asked.some((b) => b.image === "acme-api:local"));
    assert.match(
      (await reportLines(runId)).join(" | "),
      /acme-api:local is in no registry.*copied to this one/,
    );
    assert.equal((await blockingLines(runId)).length, 0);
  } finally {
    restore();
  }
});

test("an image the old server will not hand over blocks the app", async () => {
  const restore = registryAnswering();
  try {
    targetAgent();
    fakeDeplo(
      deploExport({ apps: [fromImage("acme-api:local")], databases: [] }),
      () => new Response("boom", { status: 500 }),
    );
    const runId = await importDeploProject("prc_shop");
    assert.match(
      (await blockingLines(runId)).join(" | "),
      /acme-api:local is in no registry.*could not be copied here/,
    );
  } finally {
    restore();
  }
});

test("an image a registry still has is pulled there, not copied", async () => {
  const restore = registryAnswering(200);
  try {
    const loaded = targetAgent();
    const source = fakeDeplo(
      deploExport({ apps: [fromImage("nginx:1.27")], databases: [] }),
    );
    await importDeploProject("prc_shop");
    assert.equal(loaded.length, 0);
    assert.ok(!source.asked.some((b) => b.image));
  } finally {
    restore();
  }
});
