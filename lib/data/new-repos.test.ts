import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { memberships } from "../db/schema/control-plane/access-control";
import { gitConnections } from "../db/schema/control-plane/integrations";
import { runWithIdentity } from "../auth/request-context";
import { encryptSecret } from "../crypto";
import { nowIso } from "../ids";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  listNewRepos,
  pickNewRepos,
  repoKey,
  setSuggestNewRepos,
  suggestNewReposEnabled,
  type NewRepo,
} from "./new-repos";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const USER_2 = "user_2";
const USER_3 = "user_3";

function repo(fullName: string, ageDays: number, provider = "github"): NewRepo {
  return {
    provider: provider as NewRepo["provider"],
    fullName,
    name: fullName.split("/")[1]!,
    defaultBranch: "main",
    url: `https://example.com/${fullName}`,
    private: false,
    createdAt: new Date(NOW - ageDays * DAY).toISOString(),
    installationId: null,
    connectionId: null,
  };
}

test("a repository from six days ago is suggested, one from eight is not", () => {
  const picked = pickNewRepos(
    [repo("acme/fresh", 6), repo("acme/stale", 8)],
    new Set(),
    NOW,
  );
  assert.deepEqual(
    picked.map((r) => r.fullName),
    ["acme/fresh"],
  );
});

test("a repository an app already deploys is not suggested, whatever its case", () => {
  const picked = pickNewRepos(
    [repo("Acme/Shop", 1), repo("acme/shop", 1, "gitlab")],
    new Set([repoKey("github", "acme/shop")]),
    NOW,
  );
  assert.deepEqual(
    picked.map((r) => `${r.provider}:${r.fullName}`),
    ["gitlab:acme/shop"],
    "the same name on another host is a different repository",
  );
});

test("the newest three are suggested, newest first", () => {
  const picked = pickNewRepos(
    [
      repo("acme/a", 4),
      repo("acme/b", 1),
      repo("acme/c", 3),
      repo("acme/d", 2),
    ],
    new Set(),
    NOW,
  );
  assert.deepEqual(
    picked.map((r) => r.fullName),
    ["acme/b", "acme/d", "acme/c"],
  );
});

test("newest first across hosts that write the time in different time zones", () => {
  const at = (fullName: string, createdAt: string) => ({
    ...repo(fullName, 1),
    createdAt,
  });
  const picked = pickNewRepos(
    [
      at("acme/gitea", "2026-10-26T10:00:00+02:00"),
      at("acme/github", "2026-10-26T09:00:00Z"),
      at("acme/bitbucket", "2026-10-26T08:30:00.123456+00:00"),
    ],
    new Set(),
    NOW,
  );
  assert.deepEqual(
    picked.map((r) => r.fullName),
    ["acme/github", "acme/bitbucket", "acme/gitea"],
  );
});

let db: TestDb;
let pg: PGlite;
const realFetch = globalThis.fetch;
let fetched: string[] = [];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table git_connections, account, memberships, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_A, role: "owner" },
      {
        id: USER_3,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "create_apps"],
      },
    ],
  });
  await db.insert(memberships).values({
    id: "mem_user_1_b",
    userId: USER_1,
    teamId: TEAM_B,
    role: "owner",
    createdAt: nowIso(),
  });
  fetched = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

async function seedGitea(id: string): Promise<void> {
  await db.insert(gitConnections).values({
    id,
    teamId: TEAM_A,
    provider: "gitea",
    label: "Acme Gitea",
    baseUrl: "https://git.acme.com",
    username: "deplo",
    tokenEnc: encryptSecret("t"),
    webhookSecretEnc: encryptSecret("w"),
    webhookToken: `wht_${id}`,
    createdAt: nowIso(),
    createdBy: USER_1,
  });
}

// One pushed repository from yesterday and one created yesterday with no commit yet.
function stubGitea(): void {
  const yesterday = new Date(Date.now() - DAY).toISOString();
  const row = (name: string) => ({
    full_name: `acme/${name}`,
    name,
    private: true,
    default_branch: "main",
    html_url: `https://gitea.internal/acme/${name}`,
    updated_at: yesterday,
    created_at: yesterday,
  });
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    fetched.push(u);
    const body = u.includes("/user/repos")
      ? [row("shop"), row("empty")]
      : u.includes("/repos/acme/shop/branches")
        ? [{ name: "main" }]
        : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

test("turning suggestions off touches only the caller, only in the active team", async () => {
  assert.equal(await asUser1(() => suggestNewReposEnabled()), true);
  await asUser1(() => setSuggestNewRepos(false));
  assert.equal(await asUser1(() => suggestNewReposEnabled()), false);
  assert.equal(
    await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
      suggestNewReposEnabled(),
    ),
    true,
    "the same person's other team keeps its own setting",
  );
  assert.equal(
    await runWithIdentity({ userId: USER_2, teamId: TEAM_A }, () =>
      suggestNewReposEnabled(),
    ),
    true,
    "a teammate is never turned off by someone else",
  );
});

test("a new repository with a commit is suggested, an empty one is not", async () => {
  await seedGitea("gitc_pushed");
  stubGitea();
  const found = await asUser1(() => listNewRepos());
  assert.deepEqual(
    found.map((r) => [r.provider, r.fullName, r.connectionId, r.url]),
    [["gitea", "acme/shop", "gitc_pushed", "https://git.acme.com/acme/shop"]],
    "the clone URL is on the connection's host, whatever address the host reports",
  );
});

test("with suggestions off, no host is asked at all", async () => {
  await seedGitea("gitc_off");
  stubGitea();
  await asUser1(() => setSuggestNewRepos(false));
  assert.deepEqual(await asUser1(() => listNewRepos()), []);
  assert.deepEqual(fetched, []);
});

test("a member who could create the app but not deploy it is shown nothing", async () => {
  await seedGitea("gitc_nodeploy");
  stubGitea();
  const found = await runWithIdentity({ userId: USER_3, teamId: TEAM_A }, () =>
    listNewRepos(),
  );
  assert.deepEqual(found, []);
  assert.deepEqual(fetched, []);
});
