import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import type { PGlite } from "@electric-sql/pglite";

import type { TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapsTable,
} from "../../db/schema/control-plane/access-control";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  TRUNCATE_IDENTITY,
  USER_1,
} from "../identity-test-helpers";
import {
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "../app-graph-test-helpers";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "../domains/dns-check";
import { settleProvisioning } from "../backup-test-helpers";
import {
  __setMigrationFetchForTest,
  __resetMigrationFetchForTest,
} from "../../migration/transport";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { __resetAcceptedKeysForTest } from "../../migration/dokploy/client";
import { addServer } from "../servers/enrollment";
import { importMigrationProject } from "./project-import";
import { getMigrationRun } from "./run-queries";

export const URL_BASE = "https://dokploy.acme.test";
export const CONNECT = { url: URL_BASE, apiKey: "dk_test_key" };

export const USER_2 = "user_2";
export const USER_3 = "user_3";
export const USER_4 = "user_4";

export type Fixtures = Record<
  string,
  unknown | { __status: number; body?: string }
>;

export const source: { fixtures: Fixtures; calls: string[] } = {
  fixtures: {},
  calls: [],
};

export const DOKPLOY_ICON = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>',
).toString("base64")}`;

const COMPOSE_WITH_DOKPLOY_NETWORK = [
  "services:",
  "  web:",
  "    image: nginx:1.27",
  "    volumes:",
  "      - ../files/nginx.conf:/etc/nginx/nginx.conf:ro",
  "    networks:",
  "      - dokploy-network",
  "networks:",
  "  dokploy-network:",
  "    external: true",
].join("\n");

export function defaultFixtures(): Fixtures {
  return {
    "organization.active": { id: "org_acme", name: "Acme Inc" },
    "organization.all": [
      { id: "org_acme", name: "Acme Inc" },
      { id: "org_side", name: "Side Projects" },
    ],
    "server.all": [
      { serverId: "dok-srv-1", name: "eu-1", ipAddress: "203.0.113.10" },
    ],
    "user.all": [
      { role: "owner", user: { email: "owner@acme.test", name: "Owner" } },
      { role: "member", user: { email: "dev@acme.test", name: "Dev" } },
    ],
    "project.all": [
      {
        projectId: "dok-prj-blink",
        name: "Blink",
        env: "SHARED_TOKEN=project-level\n",
        environments: [
          {
            environmentId: "dok-env-prod",
            name: "production",
            isDefault: true,
            env: "ENV_LEVEL=yes\n",
            applications: [
              {
                applicationId: "dok-app-web",
                name: "blink-web",
                serverId: null,
              },
              {
                applicationId: "dok-app-api",
                name: "blink-api",
                serverId: null,
              },
            ],
            compose: [],
            postgres: [{ postgresId: "dok-pg-1" }],
          },
        ],
      },
      {
        projectId: "dok-prj-other",
        name: "Other",
        env: "SHARED_TOKEN=other-level\n",
        environments: [
          {
            environmentId: "dok-env-stg",
            name: "staging",
            applications: [],
            compose: [
              { composeId: "dok-cmp-1", name: "other-stack", serverId: null },
            ],
            libsql: [{ libsqlId: "dok-libsql-1", name: "other-libsql" }],
          },
        ],
      },
    ],
    "compose.one": {
      composeId: "dok-cmp-1",
      name: "other-stack",
      appName: "other-stack-xyz",
      sourceType: "raw",
      composeFile: COMPOSE_WITH_DOKPLOY_NETWORK,
      env: "STACK_VAR=1\nSHARED_TOKEN=${{project.SHARED_TOKEN}}\n",
      domains: [
        {
          domainId: "d-3",
          host: "stack.acme.test",
          serviceName: "web",
          port: 80,
          certificateType: "letsencrypt",
        },
      ],
      mounts: [
        {
          mountId: "m-3",
          type: "file",
          filePath: "nginx.conf",
          content: "server { listen 80; }\n",
          mountPath: "",
        },
      ],
    },
    "postgres.stop": { ok: true },
    "postgres.one": {
      postgresId: "dok-pg-1",
      name: "blink-db",
      appName: "blink-db-abc",
      dockerImage: "postgres:16",
      databaseName: "blink",
      databaseUser: "blink",
      databasePassword: "Sup3r-secret!pw",
      externalPort: 5432,
      mounts: [],
    },
  };
}

export const APPLICATIONS: Record<string, unknown> = {
  "dok-app-web": {
    applicationId: "dok-app-web",
    name: "blink-web",
    appName: "blink-web-abc",
    icon: DOKPLOY_ICON,
    sourceType: "github",
    buildType: "nixpacks",
    owner: "acme",
    repository: "blink",
    branch: "main",
    buildPath: "apps/web",
    env:
      "DATABASE_URL=postgres://blink:pw@blink-db-abc:5432/blink\nNODE_ENV=production\n" +
      "QUEUE_DSN=postgres://blink:pw@dok-pg-1:5432/blink\n" +
      "OLD_ADDRESS=https://blink-web-abc.traefik.me/health\n" +
      "OLD_ADDRESS_URL=https://hooker:pw@blink-web-abc.traefik.me/hook\n" +
      "LEGACY_TOKEN=\n",
    buildArgs: "NEXT_PUBLIC_SITE=https://blink.acme.test\n",
    memoryLimit: "512m",
    cpuLimit: "0.5",
    autoDeploy: true,
    domains: [
      { domainId: "d-1", host: "blink-web-abc.traefik.me", port: 3000 },
      {
        domainId: "d-2",
        host: "blink.acme.test",
        port: 3000,
        certificateType: "letsencrypt",
      },
    ],
    mounts: [
      {
        mountId: "m-1",
        type: "file",
        filePath: "./config.json",
        content: '{"ok":true}',
        mountPath: "/app/config.json",
      },
      {
        mountId: "m-2",
        type: "volume",
        volumeName: "uploads",
        mountPath: "/app/uploads",
      },
    ],
    ports: [
      { portId: "p-1", publishedPort: 8080, targetPort: 3000, protocol: "tcp" },
    ],
    security: [],
  },
  "dok-app-api": {
    applicationId: "dok-app-api",
    name: "blink-api",
    appName: "blink-api-def",
    serverId: "dok-srv-1",
    sourceType: "docker",
    buildType: "dockerfile",
    dockerImage: "ghcr.io/acme/api:1.4.2",
    env:
      "PORT=8000\n" +
      "SHARED_TOKEN=${{project.SHARED_TOKEN}}\n" +
      "TOKEN_COPY=${{project.SHARED_TOKEN}}\n",
    domains: [],
    mounts: [],
    ports: [],
    security: [],
  },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function routingFetch(
  opts: {
    failApplication?: string;
    applications?: Record<string, unknown>;
  } = {},
) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (/^\/api\/(v1|health)\b/.test(url.pathname))
      return new Response("not found", { status: 404 });

    const procedure = url.pathname.replace(/^\/api\//, "");
    source.calls.push(procedure);
    assert.equal(new Headers(init?.headers).get("x-api-key"), CONNECT.apiKey);

    if (procedure === "application.one") {
      const id = url.searchParams.get("applicationId") ?? "";
      if (id === opts.failApplication)
        return new Response("upstream exploded", { status: 500 });
      const body = opts.applications?.[id] ?? APPLICATIONS[id];
      if (!body) return new Response("not found", { status: 404 });
      return json(body);
    }
    const hit = source.fixtures[procedure];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (hit && typeof hit === "object" && "__status" in hit) {
      const fail = hit as { __status: number; body?: string };
      return new Response(fail.body ?? "boom", { status: fail.__status });
    }
    return json(hit);
  };
}

export function asViewerAdmin<T>(fn: () => Promise<T>): Promise<T> {
  return runWithIdentity({ userId: USER_4, teamId: TEAM_A }, fn);
}

export function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
}

export function asMember<T>(fn: () => Promise<T>): Promise<T> {
  return runWithIdentity({ userId: USER_3, teamId: TEAM_A }, fn);
}

export function importProject(runId: string, projectId: string) {
  return asOwner(() =>
    importMigrationProject({ ...CONNECT, runId, projectId }),
  );
}

export async function openMigrationHarness(db: TestDb): Promise<void> {
  __setTestDb(db);
  __setDnsResolve4ForTest(async () => ["10.0.0.1"]);
}

export async function closeMigrationHarness(
  db: TestDb,
  pg: PGlite,
): Promise<void> {
  await settleProvisioning(db);
  __resetDnsResolve4ForTest();
  __resetMigrationFetchForTest();
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
}

export async function resetMigrationHarness(db: TestDb): Promise<void> {
  await settleProvisioning(db);
  await db.execute(TRUNCATE_PROJECT_GRAPH);
  await db.execute(TRUNCATE_IDENTITY);
  await db.execute("truncate table migration_runs cascade;");
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: USER_2,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "create_projects"],
      },
      {
        id: USER_3,
        teamId: TEAM_A,
        role: "member",
        capabilities: [
          "view",
          "create_projects",
          "create_apps",
          "create_databases",
          "manage_env",
          "manage_domains",
          "configure_apps",
        ],
      },
      {
        id: USER_4,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view"],
        isInstanceAdmin: true,
      },
    ],
  });
  await seedServer(db);
  source.fixtures = defaultFixtures();
  __setMigrationFetchForTest(routingFetch());
  __resetAcceptedKeysForTest();
  __setAgentConnectorForTest();
  await db.execute("truncate table databases cascade;");
  source.calls = [];
}

export async function seedSource(
  db: TestDb,
  name: string,
  host: string,
  withAgent = false,
) {
  const { server } = await asOwner(() =>
    addServer({ name, host, importOnly: true }),
  );
  if (withAgent)
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: `sha256:${server.id}`, agentPort: 9443 })
      .where(eq(serversTable.id, server.id));
  return server.id;
}

export async function provisionServer1(
  db: TestDb,
  taken: number[] = [],
): Promise<{ probed: number[] }> {
  await db
    .update(serversTable)
    .set({
      agentPort: 9443,
      agentCertFingerprint: "sha256:pinned",
      agentCertPem: "-----BEGIN CERTIFICATE-----",
      agentVersion: "1.27.0",
    })
    .where(eq(serversTable.id, SERVER_1));
  const held = new Set(taken);
  const probed: number[] = [];
  __setAgentConnectorForTest(
    async () =>
      ({
        checkPort: async (port: number) => {
          probed.push(port);
          return {
            available:
              !held.has(port) || source.calls.includes("postgres.stop"),
            reason: "",
          };
        },
        reroute: async () => ({ ok: true, error: "" }),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<
          typeof import("../../infra/agent-client/connect").connectAgent
        >
      >,
  );
  return { probed };
}

export async function grantExposePorts(db: TestDb): Promise<void> {
  await db.execute(
    `update users set can_expose_ports = true where id = '${USER_1}'`,
  );
}

export const dbRowOf = async (db: TestDb, name: string) =>
  (await db.select().from(databasesTable)).find((d) => d.name === name);

export const notesOf = async (runId: string) =>
  (await asOwner(() => getMigrationRun(runId)))!.items
    .filter((i) => i.sourceKind === "postgres")
    .map((i) => i.message ?? "")
    .join(" | ");

export async function inBothTeams(
  db: TestDb,
  membershipId: string,
  userId: string,
  capabilities: string[],
): Promise<void> {
  await db.insert(membershipsTable).values({
    id: membershipId,
    userId,
    teamId: TEAM_B,
    role: "member",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(membershipCapsTable).values(
    capabilities.map((capability) => ({
      membershipId,
      capability: capability as "view",
    })),
  );
}
