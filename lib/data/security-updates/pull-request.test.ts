import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { PGlite } from "@electric-sql/pglite";

import { runWithIdentity } from "../../auth/request-context";
import { encryptSecret } from "../../crypto";
import { __resetTestDb, __setTestDb } from "../../db/client";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import {
  imageInventories,
  securityFindings,
  workloadImages,
} from "../../db/schema/control-plane/security-updates";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import type { PreparePackageUpdateRequest } from "../../agent/gen/agent";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { seedApp, seedServer, SERVER_1 } from "../app-graph-test-helpers";
import { seedIdentity, TEAM_A } from "../identity-test-helpers";
import { seedGithubApp, seedGithubInstallation } from "../infra-test-helpers";
import { openSecurityPullRequest } from "./pull-request";
import { appSecurityUpdates } from "./read";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const OWNER = "u_owner";
const MEMBER = "u_member";
const IMG = "sha256:" + "1".repeat(64);
const HEAD = "a".repeat(40);
const BRANCH = "deplo/security/minimist-1.2.8";
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const as = <T>(userId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

let calls: { method: string; path: string; body: unknown }[];
let permissions: Record<string, string>;
let refsStatus: number;
let openPrs: unknown[];
let agentCalls: PreparePackageUpdateRequest[];
let restoreFetch: () => void;
let n = 0;

const ALL_WRITE = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
};

function stubGithub() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname + url.search;
    calls.push({
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const json = (status: number, v: unknown) =>
      new Response(JSON.stringify(v), { status });
    const repo = "/repos/acme/web";
    if (path === "/app")
      return json(200, {
        slug: "deplo-acme",
        permissions,
        events: ["push"],
        owner: { login: "acme", type: "Organization" },
      });
    if (path.endsWith("/access_tokens"))
      return json(201, {
        token: "ghs_test",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    if (path === `${repo}/branches/main`)
      return json(200, { commit: { sha: HEAD } });
    if (path.startsWith(`${repo}/pulls?`)) return json(200, openPrs);
    if (path === `${repo}/git/commits/${HEAD}`)
      return json(200, { tree: { sha: "tree0" } });
    if (path === `${repo}/git/trees`) return json(201, { sha: "tree1" });
    if (path === `${repo}/git/commits`) return json(201, { sha: "commit1" });
    if (path === `${repo}/git/refs`) return json(refsStatus, {});
    if (path.startsWith(`${repo}/git/refs/heads/`)) return json(200, {});
    if (path === `${repo}/pulls` && method === "POST")
      return json(201, {
        number: 7,
        html_url: "https://github.com/acme/web/pull/7",
      });
    return json(404, {});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const fakeAgent = {
  hello: async () => ({ capabilities: ["packages.update"] }),
  preparePackageUpdate: async (req: PreparePackageUpdateRequest) => {
    agentCalls.push(req);
    return {
      error: "",
      manager: "npm",
      baseCommit: HEAD,
      files: [
        {
          path: "package.json",
          gzip: gzipSync('{"overrides":{"minimist":"1.2.8"}}'),
        },
        { path: "package-lock.json", gzip: gzipSync('{"lockfileVersion":3}') },
      ],
    };
  },
  close: () => {},
};

async function seedFindings() {
  await db
    .insert(imageInventories)
    .values({ imageId: IMG, status: "ok", scannedAt: T0 });
  await db.insert(workloadImages).values({
    serverId: SERVER_1,
    workloadId: "prj_web",
    service: "web",
    kind: "app",
    teamId: TEAM_A,
    appId: "prj_web",
    imageRef: "deplo/web:1",
    imageId: IMG,
    running: true,
    seenAt: T0,
    checkedAt: T0,
  });
  const base = {
    serverId: SERVER_1,
    workloadId: "prj_web",
    service: "web",
    ecosystem: "npm",
    packageName: "minimist",
    installedVersion: "1.2.5",
    location: "/app/node_modules/minimist/package.json",
    level: "critical",
    fix: "code",
    via: "mkdirp",
    firstSeenAt: T0,
  };
  await db.insert(securityFindings).values([
    { ...base, vulnId: "GHSA-a", fixedVersion: "1.2.6" },
    { ...base, vulnId: "GHSA-b", fixedVersion: "1.2.8" },
  ]);
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table security_pull_requests, security_findings, workload_images,
    image_inventories, github_installation, github_apps, app_build_method_settings, app_build,
    apps, servers, membership_capabilities, memberships, users, teams, instance_settings
    restart identity cascade;`);
  calls = [];
  agentCalls = [];
  permissions = ALL_WRITE;
  refsStatus = 201;
  openPrs = [];
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      {
        id: MEMBER,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "deploy_apps"],
      },
    ],
  });
  await db
    .insert(instanceSettings)
    .values({ id: "default", updatedAt: T0 })
    .onConflictDoNothing();
  await seedServer(db);
  // A fresh GitHub App each test: its access answer is cached for a minute.
  n += 1;
  await seedGithubApp(db, {
    id: `gha_${n}`,
    teamId: TEAM_A,
    privateKeyEnc: encryptSecret(PEM),
  });
  await seedGithubInstallation(db, { id: `ghi_${n}`, appId: `gha_${n}` });
  await seedApp(db, {
    id: "prj_web",
    teamId: TEAM_A,
    repo: {
      provider: "github",
      url: "https://github.com/acme/web",
      repo: "acme/web",
      branch: "main",
      installationId: `ghi_${n}`,
    },
  });
  await seedFindings();
  restoreFetch = stubGithub();
  __setAgentConnectorForTest(
    async () => fakeAgent as unknown as AgentConnection,
  );
});

afterEach(() => {
  restoreFetch();
  __setAgentConnectorForTest();
});

const posted = (suffix: string) =>
  calls.filter(
    (c) => c.method !== "GET" && c.path === `/repos/acme/web${suffix}`,
  );

test("opens one pull request on the branch head, pinning an indirect copy at the version that closes every advisory", async () => {
  const pr = await as(OWNER, () =>
    openSecurityPullRequest("prj_web", "minimist"),
  );
  assert.deepEqual(pr, {
    number: 7,
    url: "https://github.com/acme/web/pull/7",
    accessUrl: null,
  });

  assert.equal(agentCalls.length, 1);
  const req = agentCalls[0];
  assert.equal(req.package, "minimist");
  assert.equal(req.version, "1.2.8");
  assert.equal(req.override, true, "mkdirp pulls it in");
  assert.equal(req.git?.commit, HEAD);
  assert.equal(req.git?.branch, "main");

  const tree = posted("/git/trees")[0].body as {
    base_tree: string;
    tree: { path: string; content: string }[];
  };
  assert.equal(tree.base_tree, "tree0");
  assert.deepEqual(
    tree.tree.map((f) => f.path),
    ["package.json", "package-lock.json"],
  );
  assert.match(tree.tree[0].content, /"minimist":"1\.2\.8"/);
  assert.deepEqual(posted("/git/commits")[0].body, {
    message: "fix(deps): minimist 1.2.8",
    tree: "tree1",
    parents: [HEAD],
  });
  assert.deepEqual(posted("/git/refs")[0].body, {
    ref: `refs/heads/${BRANCH}`,
    sha: "commit1",
  });
  const body = posted("/pulls")[0].body as Record<string, string>;
  assert.equal(body.title, "Security update: minimist 1.2.8");
  assert.equal(body.head, BRANCH);
  assert.equal(body.base, "main");
  assert.match(body.body, /GHSA-a/);
  assert.match(body.body, /GHSA-b/);
  assert.match(body.body, /mkdirp pulls it in/);

  const read = await as(OWNER, () => appSecurityUpdates("prj_web"));
  assert.equal(read?.canOpenPullRequests, true);
  assert.deepEqual(read?.groups[0].pullRequest, {
    number: 7,
    url: "https://github.com/acme/web/pull/7",
  });
});

test("asking again returns the pull request already open on that branch", async () => {
  openPrs = [{ number: 7, html_url: "https://github.com/acme/web/pull/7" }];
  const pr = await as(OWNER, () =>
    openSecurityPullRequest("prj_web", "minimist"),
  );
  assert.equal(pr.number, 7);
  assert.equal(posted("/pulls").length, 0);
  assert.equal(posted("/git/refs").length, 0);
});

test("a branch left by a closed pull request is moved to the new commit", async () => {
  refsStatus = 422;
  await as(OWNER, () => openSecurityPullRequest("prj_web", "minimist"));
  assert.deepEqual(posted(`/git/refs/heads/${BRANCH}`)[0].body, {
    sha: "commit1",
    force: true,
  });
});

test("without write access on the GitHub App it answers where to grant it, before the server does any work", async () => {
  permissions = { metadata: "read", contents: "read" };
  const pr = await as(OWNER, () =>
    openSecurityPullRequest("prj_web", "minimist"),
  );
  assert.equal(
    pr.accessUrl,
    "https://github.com/organizations/acme/settings/apps/deplo-acme/permissions",
  );
  assert.equal(pr.number, null);
  assert.equal(agentCalls.length, 0);
});

test("an installation that has not accepted the new access answers its own settings page", async () => {
  refsStatus = 403;
  const pr = await as(OWNER, () =>
    openSecurityPullRequest("prj_web", "minimist"),
  );
  assert.equal(
    pr.accessUrl,
    "https://github.com/organizations/acct/settings/installations/5000",
  );
});

test("a member without the Capability is refused and is not offered the button", async () => {
  await assert.rejects(
    as(MEMBER, () => openSecurityPullRequest("prj_web", "minimist")),
    /permission/,
  );
  const read = await as(MEMBER, () => appSecurityUpdates("prj_web"));
  assert.equal(read?.canOpenPullRequests, false);
  assert.equal(agentCalls.length, 0);
});

test("a package with no fix in the app's code is refused", async () => {
  await assert.rejects(
    as(OWNER, () => openSecurityPullRequest("prj_web", "left-pad")),
    /no fix Deplo can move/,
  );
});
