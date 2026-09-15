import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  connectGitProvider,
  gitConnectionInTeam,
  listGitConnections,
  readGitCredential,
  removeGitConnection,
  updateGitConnection,
} from "./git-connections";
import { resolveCloneUrl, redactCloneUrl } from "../git/clone-url";
import { updateAppSource } from "./apps/source";
import { loadAppGraph } from "./app-graph-load";
import { gitConnections as gitConnectionsTable } from "../db/schema/control-plane/integrations";
import { encryptSecret } from "../crypto";
import { nowIso } from "../ids";
import {
  __setDnsLookupForTest,
  __resetDnsLookupForTest,
} from "../outbound-url";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setDnsLookupForTest(async (host) =>
    host === "git.internal.example.com"
      ? [{ address: "10.0.0.7" }]
      : [{ address: "93.184.216.34" }],
  );
});

after(async () => {
  __resetDnsLookupForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table git_connections cascade;
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
      { id: "user_3", teamId: TEAM_A, role: "owner", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
});

const asTeamA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_2", teamId: TEAM_B }, fn);

const connect = (label = "Acme git") =>
  connectGitProvider({
    provider: "git",
    label,
    baseUrl: "git.acme.com",
    username: "deploy",
    token: "s3cret-token",
  });

test("a connection round-trips with no token in the DTO", async () => {
  const created = await asTeamA(() => connect());
  assert.equal(created.provider, "git");
  assert.equal(created.baseUrl, "https://git.acme.com");
  assert.equal(created.hasApi, false);
  assert.equal(created.appCount, 0);

  const listed = await asTeamA(() => listGitConnections());
  assert.equal(listed.length, 1);
  assert.ok(
    !JSON.stringify(listed[0]).includes("s3cret-token"),
    "the token must never reach a DTO",
  );
  assert.ok(!("tokenEnc" in listed[0]), "no ciphertext field either");
});

test("the stored token is encrypted at rest and readable only internally", async () => {
  const created = await asTeamA(() => connect());
  const rows = await db.select().from(gitConnectionsTable);
  assert.equal(rows.length, 1);
  assert.ok(
    !rows[0].tokenEnc.includes("s3cret-token"),
    "the column holds ciphertext",
  );
  const cred = await readGitCredential(created.id);
  assert.equal(cred?.token, "s3cret-token");
  assert.equal(cred?.username, "deploy");
});

test("a connection is invisible to another team", async () => {
  const created = await asTeamA(() => connect());
  assert.deepEqual(await asTeamB(() => listGitConnections()), []);
  assert.equal(await gitConnectionInTeam(created.id, TEAM_B), false);
  assert.equal(await gitConnectionInTeam(created.id, TEAM_A), true);
});

test("another team can neither edit nor delete it", async () => {
  const created = await asTeamA(() => connect());
  await assert.rejects(
    () => asTeamB(() => updateGitConnection(created.id, { label: "stolen" })),
    /not found/i,
  );
  await assert.rejects(
    () => asTeamB(() => removeGitConnection(created.id)),
    /not found/i,
  );
  assert.equal(
    (await asTeamA(() => listGitConnections()))[0].label,
    "Acme git",
  );
});

test("rotating the token replaces it and keeps the rest", async () => {
  const created = await asTeamA(() => connect());
  const updated = await asTeamA(() =>
    updateGitConnection(created.id, { label: "Renamed", token: "new-token" }),
  );
  assert.equal(updated.label, "Renamed");
  assert.equal((await readGitCredential(created.id))?.token, "new-token");

  await asTeamA(() => updateGitConnection(created.id, { token: "" }));
  assert.equal((await readGitCredential(created.id))?.token, "new-token");
});

test("an address with credentials in it is refused", async () => {
  await assert.rejects(
    () =>
      asTeamA(() =>
        connectGitProvider({
          provider: "git",
          label: "Sneaky",
          baseUrl: "https://user:pass@git.acme.com",
          username: "deploy",
          token: "t",
        }),
      ),
    /token field/i,
  );
});

test("removing a connection unlinks its apps and stops their auto-deploy", async () => {
  const created = await asTeamA(() => connect());
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asTeamA(() =>
    updateAppSource("prj_1", {
      source: "git",
      dockerImage: null,
      repo: {
        provider: "git",
        url: "https://git.acme.com/acme/site",
        repo: "acme/site",
        branch: "main",
        connectionId: created.id,
      },
    }),
  );
  assert.equal((await loadAppGraph("prj_1"))?.repo?.connectionId, created.id);
  assert.equal((await asTeamA(() => listGitConnections()))[0].appCount, 1);

  const unlinked = await asTeamA(() => removeGitConnection(created.id));
  assert.equal(unlinked, 1);
  const after = await loadAppGraph("prj_1");
  assert.equal(after?.repo?.connectionId ?? null, null);
  assert.equal(after?.autoDeploy, false);
  assert.deepEqual(await asTeamA(() => listGitConnections()), []);
});

test("a connection-backed clone carries its credentials in the userinfo", async () => {
  const created = await asTeamA(() => connect());
  const url = await resolveCloneUrl({
    provider: "git",
    url: "https://git.acme.com/acme/site.git",
    repo: "acme/site",
    branch: "main",
    connectionId: created.id,
  });
  assert.equal(url, "https://deploy:s3cret-token@git.acme.com/acme/site.git");
  assert.equal(redactCloneUrl(url), "https://git.acme.com/acme/site.git");
});

test("a repo URL on a FOREIGN host does NOT carry the connection's token", async () => {
  const created = await asTeamA(() => connect());
  const attackerUrl = "https://collector.attacker.test/acme/site.git";
  const url = await resolveCloneUrl({
    provider: "git",
    url: attackerUrl,
    repo: "acme/site",
    branch: "main",
    connectionId: created.id,
  });
  assert.equal(url, attackerUrl);
  const parsed = new URL(url);
  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
});

test("a token full of URL metacharacters survives the round trip", async () => {
  const created = await asTeamA(() =>
    connectGitProvider({
      provider: "git",
      label: "Awkward",
      baseUrl: "https://git.acme.com",
      username: "a@b",
      token: "p:a/s@s w0rd",
    }),
  );
  const url = await resolveCloneUrl({
    provider: "git",
    url: "https://git.acme.com/acme/site.git",
    repo: "acme/site",
    branch: "main",
    connectionId: created.id,
  });
  const parsed = new URL(url);
  assert.equal(decodeURIComponent(parsed.username), "a@b");
  assert.equal(decodeURIComponent(parsed.password), "p:a/s@s w0rd");
  assert.equal(parsed.host, "git.acme.com");
  assert.equal(parsed.pathname, "/acme/site.git");
});

test("a repo with no credential clones exactly as typed", async () => {
  const plain = {
    provider: "git" as const,
    url: "https://git.acme.com/acme/public.git",
    repo: "acme/public",
    branch: "main",
  };
  assert.equal(await resolveCloneUrl(plain), plain.url);
  const created = await asTeamA(() => connect());
  assert.equal(
    await resolveCloneUrl({
      ...plain,
      url: "git@git.acme.com:acme/public.git",
      connectionId: created.id,
    }),
    "git@git.acme.com:acme/public.git",
  );
});

test("a connection deleted out from under an app clones anonymously", async () => {
  const created = await asTeamA(() => connect());
  await asTeamA(() => removeGitConnection(created.id));
  assert.equal(
    await resolveCloneUrl({
      provider: "git",
      url: "https://git.acme.com/acme/site.git",
      repo: "acme/site",
      branch: "main",
      connectionId: created.id,
    }),
    "https://git.acme.com/acme/site.git",
  );
});

test("an app cannot borrow another team's connection", async () => {
  const theirs = await asTeamB(() => connect("Their git"));
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asTeamA(() =>
    updateAppSource("prj_1", {
      source: "git",
      dockerImage: null,
      repo: {
        provider: "git",
        url: "https://git.acme.com/acme/site",
        repo: "acme/site",
        branch: "main",
        connectionId: theirs.id,
      },
    }),
  );
  const app = await loadAppGraph("prj_1");
  assert.equal(app?.repo?.connectionId ?? null, null);
  assert.equal(app?.repo?.repo, "acme/site");
});

const connectTo = (baseUrl: string, allowPrivateEndpoint = false) =>
  connectGitProvider({
    provider: "git",
    label: "Somewhere",
    baseUrl,
    username: "deploy",
    token: "t",
    allowPrivateEndpoint,
  });

test("an address inside the deployment is refused", async () => {
  for (const addr of [
    "http://169.254.169.254",
    "http://127.0.0.1:3000",
    "https://10.0.0.5",
    "https://192.168.1.10",
    "https://172.16.4.4",
    "http://localhost:8080",
    "https://[::1]",
  ]) {
    await assert.rejects(
      () => asTeamA(() => connectTo(addr)),
      /private or internal/,
      `${addr} must be refused`,
    );
  }
});

test("a NAME that resolves inside the deployment is refused too", async () => {
  await assert.rejects(
    () => asTeamA(() => connectTo("https://git.internal.example.com")),
    /private or internal/,
  );
});

test("a private address needs instance admin, not just manage_git", async () => {
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_3", teamId: TEAM_A }, () =>
        connectTo("https://10.0.0.5", true),
      ),
    /instance admin/i,
  );
});

test("an instance admin can point a connection at their own network, and it says so", async () => {
  const created = await asTeamA(() => connectTo("https://10.0.0.5", true));
  assert.equal(created.baseUrl, "https://10.0.0.5");
  assert.equal(
    created.allowPrivateEndpoint,
    true,
    "the exception is carried on the row, not only in whoever's memory made it",
  );

  const listed = await asTeamA(() => listGitConnections());
  assert.equal(listed[0].allowPrivateEndpoint, true);
});

test("an ordinary public address still connects, and is not flagged", async () => {
  const created = await asTeamA(() => connectTo("git.acme.com"));
  assert.equal(created.baseUrl, "https://git.acme.com");
  assert.equal(created.allowPrivateEndpoint, false);
});

async function seedGitlab(tokenScopes: string): Promise<void> {
  await db.insert(gitConnectionsTable).values({
    id: "gitc_scopes",
    teamId: TEAM_A,
    provider: "gitlab",
    label: "Acme GitLab",
    baseUrl: "https://gitlab.acme.com",
    allowPrivateEndpoint: false,
    username: "oauth2",
    tokenEnc: encryptSecret("t"),
    webhookSecretEnc: encryptSecret("w"),
    webhookToken: "wht_scopes",
    accountLogin: "acme",
    avatarUrl: "",
    health: "ok",
    healthError: "",
    tokenExpiresAt: null,
    tokenScopes,
    lastCheckedAt: nowIso(),
    createdAt: nowIso(),
    createdBy: USER_1,
  });
}

test("a token short of a scope says which one, in GitLab's own word", async () => {
  await seedGitlab("read_repository");
  const [conn] = await asTeamA(() => listGitConnections());
  assert.deepEqual(
    conn!.missingAccess.map((r) => r.label),
    ["api"],
  );
  assert.equal(conn!.health, "ok");
});

test("a provider that reports no scopes is never accused", async () => {
  await seedGitlab("");
  const [conn] = await asTeamA(() => listGitConnections());
  assert.deepEqual(conn!.missingAccess, []);
});

test("GitLab's api scope covers the read one it implies", async () => {
  await seedGitlab("api");
  const [conn] = await asTeamA(() => listGitConnections());
  assert.deepEqual(conn!.missingAccess, []);
});
