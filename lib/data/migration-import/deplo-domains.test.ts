import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import type { DeploExportDomain } from "../../migration/deplo/export-shape";
import {
  deploExport,
  exportApp,
} from "../../migration/deplo/deplo-test-helpers";
import {
  traefikCertificates,
  withTraefikCertificates,
} from "../../deploy/traefik-stack";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { loadDomainsForApp } from "../app-graph-load";
import { seedApp } from "../app-graph-test-helpers";
import { TEAM_B } from "../identity-test-helpers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  ACME_CERT,
  ACME_KEY,
  TRAEFIK_STACK,
} from "../certificate-test-fixtures";
import {
  closeMigrationHarness,
  openMigrationHarness,
  provisionServer1,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import {
  blockingLines,
  importFromDeplo,
  reportLines,
} from "./deplo-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(async () => {
  await resetMigrationHarness(db);
  await provisionServer1(db);
});

const domain = (
  host: string,
  over: Partial<DeploExportDomain> = {},
): DeploExportDomain => ({
  host,
  port: null,
  pathPrefix: "",
  stripPrefix: false,
  service: null,
  https: true,
  certProvider: "letsencrypt",
  primary: false,
  redirectTo: null,
  generated: false,
  ...over,
});

async function landedDomains(name = "web") {
  const app = (await db.select().from(appsTable)).find((a) => a.name === name);
  assert.ok(app, `${name} landed`);
  return loadDomainsForApp(app.id);
}

const rules = {
  entrypoint: "websecure",
  middlewares: [],
  corsOrigins: ["https://a.example.com"],
  securityHeaders: false,
  proxied: true,
};

test("a domain's CORS origins, headers and proxy setting land on the same domain", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          domains: [
            domain("shop.example.com", { primary: true, ...rules }),
            domain("api.example.com", {
              ...rules,
              corsOrigins: ["https://b.example.com", "https://c.example.com"],
            }),
          ],
        }),
      ],
    }),
    ["prc_shop"],
  );
  const landed = await landedDomains();
  const shop = landed.find((d) => d.name === "shop.example.com");
  const api = landed.find((d) => d.name === "api.example.com");
  assert.deepEqual(
    [shop?.corsOrigins, shop?.securityHeaders, shop?.proxied],
    [["https://a.example.com"], false, true],
  );
  assert.deepEqual(
    [api?.corsOrigins, api?.securityHeaders, api?.proxied],
    [["https://b.example.com", "https://c.example.com"], false, true],
  );
  assert.deepEqual(await blockingLines(runId), []);
});

test("a domain that moves to a temporary address names the settings it left behind", async () => {
  await seedApp(db, { id: "prj_theirs", teamId: TEAM_B, slug: "theirs" });
  await db.insert(domainsTable).values({
    id: "dom_theirs",
    appId: "prj_theirs",
    name: "shop.example.com",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    entrypoint: "websecure",
    certProvider: "letsencrypt",
    stripPrefix: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          domains: [
            domain("shop.example.com", {
              primary: true,
              ...rules,
              middlewares: ["auth"],
            }),
          ],
        }),
      ],
    }),
    ["prc_shop"],
  );
  const [moved] = await landedDomains();
  assert.notEqual(moved?.name, "shop.example.com");
  const lines = (await reportLines(runId)).join("\n");
  assert.match(
    lines,
    new RegExp(
      `shop\\.example\\.com's settings did not move to ${moved!.name.replace(/\./g, "\\.")}: Allowed origins \\(https://a\\.example\\.com\\), Security headers off, Behind a proxy, Middlewares \\(auth\\)`,
    ),
  );
  assert.doesNotMatch(
    (await blockingLines(runId)).join("\n"),
    /settings did not move/,
  );
});

test("a domain keeps its middlewares, and the report names them as something to set up here", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          domains: [
            domain("shop.example.com", {
              primary: true,
              ...rules,
              middlewares: ["ratelimit@file", "auth"],
            }),
          ],
        }),
      ],
    }),
    ["prc_shop"],
  );
  const [shop] = await landedDomains();
  assert.deepEqual(shop?.middlewares, ["ratelimit@file", "auth"]);
  const lines = await blockingLines(runId);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /shop\.example\.com.*ratelimit@file, auth/);
});

test("a host that only redirected lands as the same redirect, once its target has", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          domains: [
            domain("www.example.com", {
              ...rules,
              securityHeaders: true,
              redirectTo: "example.com",
            }),
            domain("example.com", { primary: true, ...rules }),
          ],
        }),
      ],
    }),
    ["prc_shop"],
  );
  const landed = await landedDomains();
  const www = landed.find((d) => d.name === "www.example.com");
  const shop = landed.find((d) => d.name === "example.com");
  assert.equal(www?.redirectTo, "example.com");
  assert.equal(shop?.primary, true);
  assert.equal(shop?.redirectTo, null);
  assert.equal(
    (await reportLines(runId)).some((l) => /redirect/.test(l)),
    false,
  );
});

// This side's server: a proxy Deplo installed, holding what the import puts there.
function proxyHere(yaml = TRAEFIK_STACK) {
  const state = { yaml };
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({ capabilities: ["hostops"] }),
        checkPort: async () => ({ available: true, reason: "" }),
        reroute: async () => ({ ok: true, error: "" }),
        hostInfo: async () => ({ traefikComposeYaml: state.yaml }),
        traefikConfig: async (req: { composeYaml: string }) => {
          if (req.composeYaml) state.yaml = req.composeYaml;
          return { ok: true, error: "" };
        },
        close: () => {},
      }) as unknown as AgentConnection,
  );
  return state;
}

const acme = (certificate?: DeploExportDomain["certificate"]) =>
  deploExport({
    apps: [
      exportApp({
        domains: [
          domain("acme.example.com", {
            primary: true,
            ...rules,
            proxied: false,
            certProvider: "custom",
            ...(certificate ? { certificate } : {}),
          }),
        ],
      }),
    ],
  });

const linesNaming = (lines: string[], host: RegExp) =>
  lines.filter((l) => host.test(l));

test("a custom certificate is installed on this server, and its domain keeps serving it", async () => {
  const proxy = proxyHere();
  const runId = await importFromDeplo(
    acme({ certPem: ACME_CERT, keyPem: ACME_KEY }),
    ["prc_shop"],
  );
  assert.deepEqual(traefikCertificates(proxy.yaml), [
    { certPem: ACME_CERT, keyPem: ACME_KEY },
  ]);
  const [landed] = await landedDomains();
  assert.equal(landed?.certProvider, "custom");
  assert.deepEqual(await blockingLines(runId), []);
});

test("a custom certificate that did not come across is a blocker naming its domain and why", async () => {
  for (const [certificate, why] of [
    [{ withheld: "admin" }, /instance admin/],
    [{ withheld: "missing" }, /no longer holds/],
    [undefined, /too old/],
  ] as const) {
    await resetMigrationHarness(db);
    await provisionServer1(db);
    proxyHere();
    const runId = await importFromDeplo(acme(certificate), ["prc_shop"]);
    const lines = linesNaming(await blockingLines(runId), /acme\.example\.com/);
    assert.equal(lines.length, 1, JSON.stringify(certificate));
    assert.match(lines[0]!, why);
    const [landed] = await landedDomains();
    assert.notEqual(landed?.certProvider, "custom");
  }
});

test("a certificate already installed here keeps its domain on it, said as information", async () => {
  proxyHere(
    withTraefikCertificates(TRAEFIK_STACK, [
      { certPem: ACME_CERT, keyPem: ACME_KEY },
    ]),
  );
  const runId = await importFromDeplo(acme({ withheld: "admin" }), [
    "prc_shop",
  ]);
  const [landed] = await landedDomains();
  assert.equal(landed?.certProvider, "custom");
  assert.deepEqual(await blockingLines(runId), []);
  assert.equal(
    linesNaming(await reportLines(runId), /acme\.example\.com/).length,
    1,
  );
});
