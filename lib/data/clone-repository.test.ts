import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __resetTestDb, __setTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { gitConnections as gitConnectionsTable } from "../db/schema/control-plane/integrations";
import { encryptSecret } from "../crypto";
import { nowIso } from "../ids";
import {
  __resetDnsLookupForTest,
  __setDnsLookupForTest,
} from "../outbound-url";
import { fakeFetch, jsonResponse, tarGz } from "../git/clone-test-helpers";
import { cloneRepository, listCloneDestinations } from "./clone-repository";

let db: TestDb;
let pg: PGlite;
const realFetch = globalThis.fetch;

const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asViewer = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: "user_view", teamId: TEAM_A }, fn);
const asOtherTeam = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

async function seedGitlab() {
  await db.insert(gitConnectionsTable).values({
    id: "gc_lab",
    teamId: TEAM_A,
    provider: "gitlab",
    label: "Our GitLab",
    baseUrl: "https://gitlab.com",
    username: "oauth2",
    tokenEnc: encryptSecret("glpat-secret"),
    webhookSecretEnc: encryptSecret("hook"),
    webhookToken: "tok_lab",
    createdAt: nowIso(),
    createdBy: USER_1,
  });
}

// GitHub serves the public source, GitLab takes the copy.
function internet() {
  return fakeFetch([
    (c) =>
      c.url === "https://api.github.com/repos/acme/starter"
        ? jsonResponse({ private: false, default_branch: "main" })
        : null,
    (c) =>
      c.url.startsWith("https://codeload.github.com/acme/starter/tar.gz/main")
        ? new Response(
            tarGz([
              { name: "package.json", content: "{}" },
              { name: "deploy/docker-compose.yml", content: "services: {}\n" },
            ]),
          )
        : null,
    (c) =>
      c.url === "https://gitlab.com/api/v4/namespaces?per_page=100"
        ? jsonResponse([{ id: 9, full_path: "our-group", kind: "group" }])
        : null,
    (c) =>
      c.method === "POST" && c.url === "https://gitlab.com/api/v4/projects"
        ? jsonResponse({
            id: 77,
            path_with_namespace: "our-group/starter",
            web_url: "https://gitlab.com/our-group/starter",
          })
        : null,
    (c) =>
      c.url === "https://gitlab.com/api/v4/projects/77/repository/commits"
        ? jsonResponse({ id: "c1" })
        : null,
  ]);
}

describe("clone-repository", () => {
  before(async () => {
    ({ db, pg } = await makeTestDb());
    __setTestDb(db);
  });

  after(async () => {
    __resetTestDb();
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(`truncate table git_connections cascade;
      truncate table users, teams restart identity cascade;`);
    await seedIdentity(db, {
      users: [
        { id: USER_1, teamId: TEAM_A, role: "owner" },
        {
          id: "user_view",
          teamId: TEAM_A,
          role: "owner",
          capabilities: ["view"],
        },
        { id: "user_b", teamId: TEAM_B, role: "owner" },
      ],
    });
    await seedGitlab();
    __setDnsLookupForTest(async () => [{ address: "93.184.216.34" }]);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetDnsLookupForTest();
  });

  const input = {
    repo: "https://github.com/acme/starter",
    connectionId: "gc_lab",
    owner: "9",
    name: "starter",
    private: true,
  };

  test("the team's GitLab groups are where a copy can go", async () => {
    globalThis.fetch = internet().fn;
    const { destinations } = await asOwner(() => listCloneDestinations());
    assert.deepEqual(
      destinations.map((d) => [d.provider, d.login, d.ownerId, d.needs]),
      [["gitlab", "our-group", "9", null]],
    );
  });

  test("copies the project into a new private project and says where", async () => {
    const net = internet();
    globalThis.fetch = net.fn;
    const out = await asOwner(() =>
      cloneRepository({
        ...input,
        compose:
          "https://github.com/acme/starter/blob/main/deploy/docker-compose.yml",
      }),
    );
    assert.deepEqual(out, {
      provider: "gitlab",
      fullName: "our-group/starter",
      url: "https://gitlab.com/our-group/starter",
      branch: "main",
      installationId: null,
      connectionId: "gc_lab",
      composeFile: "deploy/docker-compose.yml",
      port: null,
      startCommand: null,
    });
    const commit = net.calls.find((c) => c.url.endsWith("/commits"))!;
    assert.deepEqual(
      (commit.body as { actions: { file_path: string }[] }).actions.map(
        (a) => a.file_path,
      ),
      ["package.json", "deploy/docker-compose.yml"],
    );
    assert.ok(net.calls.every((c) => c.method !== "DELETE"));
  });

  test("a compose file the repository doesn't have stops before anything is created", async () => {
    const net = internet();
    globalThis.fetch = net.fn;
    await assert.rejects(
      asOwner(() =>
        cloneRepository({
          ...input,
          compose: "https://github.com/acme/starter/blob/main/compose.yml",
        }),
      ),
      /has no compose.yml on main/,
    );
    assert.ok(!net.calls.some((c) => c.url.endsWith("/api/v4/projects")));
  });

  test("someone who can't create apps is refused before any request", async () => {
    const net = internet();
    globalThis.fetch = net.fn;
    await assert.rejects(asViewer(() => cloneRepository(input)));
    assert.equal(net.calls.length, 0);
  });

  test("another team's git connection is never used", async () => {
    globalThis.fetch = internet().fn;
    await assert.rejects(
      asOtherTeam(() => cloneRepository(input)),
      /Git account not found/,
    );
  });

  test("a link that isn't a public GitHub or GitLab repository is refused", async () => {
    globalThis.fetch = internet().fn;
    await assert.rejects(
      asOwner(() =>
        cloneRepository({ ...input, repo: "https://example.com/a/b" }),
      ),
      /public GitHub or GitLab repository/,
    );
  });
});
