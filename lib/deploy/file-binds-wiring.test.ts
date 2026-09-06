import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { status as GrpcStatus } from "@grpc/grpc-js";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { appVolumes as appVolumesTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import {
  __setAgentConnectorForTest,
  type AgentConnection,
} from "../infra/agent-client";
import { runAgentDeploy } from "./agent-deploy";
import { rerouteApp } from "./build";
import { stackFilesDir } from "./deploy-key";

/**
 * The pre-flight is wired into the two bring-ups: the deploy stream and the
 * reroute. What matters is the ORDER - the file exists before `compose up`.
 */

let db: TestDb;
let pg: PGlite;
let calls: string[] = [];
/** Paths the fake host already holds, and what they are. */
let disk: Record<string, "file" | "folder"> = {};

function grpc(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

const entry = (path: string) => ({
  path,
  name: path,
  kind: "file",
  size: 0,
  modifiedAt: "2026-01-01T00:00:00.000Z",
});

function fakeAgent(): AgentConnection {
  const conn = {
    hello: async () => {
      calls.push("hello");
      return {
        contractVersion: 1,
        dockerAvailable: true,
        agentVersion: "test",
        capabilities: [
          "deploy.build-only",
          "deploy.compose.multi",
          "deploy.network",
        ],
      };
    },
    deploy: async function* () {
      calls.push("deploy");
      yield { result: { ready: true, error: "", commitSha: "" }, seq: 1 };
    },
    readStack: async () => ({ exists: true, yaml: "services: {}\n" }),
    reroute: async () => {
      calls.push("reroute");
      return { ok: true, error: "" };
    },
    readFile: async (_slug: string, path: string) => {
      calls.push(`read ${path}`);
      if (!disk[path]) throw grpc(GrpcStatus.NOT_FOUND, "no such file");
      if (disk[path] === "folder")
        throw grpc(GrpcStatus.INVALID_ARGUMENT, "not a file");
      return { path, text: "", size: 0, reason: null };
    },
    listFiles: async (_slug: string, path: string) => {
      calls.push(`list ${path}`);
      return [];
    },
    deleteFile: async (_slug: string, path: string) => {
      calls.push(`delete ${path}`);
      delete disk[path];
    },
    writeFile: async (_slug: string, path: string) => {
      calls.push(`write ${path}`);
      disk[path] = "file";
      return entry(path);
    },
    close: () => {},
  };
  return conn as unknown as AgentConnection;
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setAgentConnectorForTest(async () => fakeAgent());
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  calls = [];
  disk = {};
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

const SLUG = "app-1";
const files = stackFilesDir(SLUG);
const sink = { log: () => {} };

function deployOpts(
  overrides: Partial<Parameters<typeof runAgentDeploy>[0]> = {},
) {
  return {
    serverId: SERVER_1,
    deployId: "dep_1",
    slug: SLUG,
    appId: "app_1",
    imageRef: "",
    composeYaml: `services:\n  web:\n    image: nginx\n    volumes:\n      - ${files}/config.yml:/app/config.yml:ro\n      - ${files}/html:/usr/share/nginx/html\n`,
    network: "deplo-team-team_a",
    env: {},
    plan: { kind: "compose" as const, mounts: [] },
    sink,
    ...overrides,
  };
}

test("runAgentDeploy: the missing file bind is created BEFORE the deploy stream", async () => {
  const r = await runAgentDeploy(deployOpts());
  assert.equal(r.ready, true);
  assert.deepEqual(calls, [
    "hello",
    "read config.yml",
    "write config.yml",
    "deploy",
  ]);
});

test("runAgentDeploy: a Storage File row is created even with a name that looks like a folder", async () => {
  await seedApp(db, { id: "app_1", slug: SLUG, source: "compose" });
  await db.insert(appVolumesTable).values({
    appId: "app_1",
    position: 0,
    volumeId: "vol_1",
    type: "app",
    name: "myconfig",
    projectPath: "myconfig",
    mountPath: "/app/myconfig",
    readOnly: false,
  });
  await runAgentDeploy(
    deployOpts({
      composeYaml: `services:\n  web:\n    image: nginx\n    volumes:\n      - ${files}/myconfig:/app/myconfig\n`,
    }),
  );
  assert.deepEqual(calls, [
    "hello",
    "read myconfig",
    "write myconfig",
    "deploy",
  ]);
});

test("runAgentDeploy: a build server gets no file pre-flight at all", async () => {
  await runAgentDeploy(deployOpts({ buildOnly: true }));
  assert.deepEqual(calls, ["hello", "deploy"]);
});

test("runAgentDeploy: a config file the agent writes itself is not pre-created", async () => {
  await runAgentDeploy(
    deployOpts({
      plan: {
        kind: "compose",
        mounts: [{ filePath: "config.yml", content: "a: 1" }],
      },
    }),
  );
  assert.deepEqual(calls, ["hello", "deploy"]);
});

test("runAgentDeploy: a file already on the host is left alone", async () => {
  disk["config.yml"] = "file";
  await runAgentDeploy(deployOpts());
  assert.deepEqual(calls, ["hello", "read config.yml", "deploy"]);
});

test("runAgentDeploy: the empty folder a past deploy left is swapped for a file", async () => {
  disk["config.yml"] = "folder";
  await runAgentDeploy(deployOpts());
  assert.deepEqual(calls, [
    "hello",
    "read config.yml",
    "list config.yml",
    "delete config.yml",
    "write config.yml",
    "deploy",
  ]);
});

test("rerouteApp: a compose stack's file bind is created before the reroute", async () => {
  await seedApp(db, {
    id: "app_1",
    slug: SLUG,
    source: "compose",
    status: "active",
    compose: `services:\n  web:\n    image: nginx\n    volumes:\n      - ./config.yml:/app/config.yml\n      - ./html:/usr/share/nginx/html\n`,
  });
  const result = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    rerouteApp("app_1"),
  );
  assert.equal(result, "rerouted");
  assert.deepEqual(calls, ["read config.yml", "write config.yml", "reroute"]);
});
