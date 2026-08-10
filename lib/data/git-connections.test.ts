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
import { updateAppSource } from "./apps";
import { loadAppGraph } from "./app-graph-load";
import { gitConnections as gitConnectionsTable } from "../db/schema/control-plane";
import {
  __setDnsLookupForTest,
  __resetDnsLookupForTest,
} from "../outbound-url";

/**
 * Git connections: the team boundary and the write-only token.
 *
 * The `git` provider is used throughout because it is the only one with no API
 * to call - every other provider would try to reach a real host from a unit
 * test. What is under test here is the data layer's scoping, not the HTTP
 * clients (those are covered, without a network, in lib/git/providers.test.ts).
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // The SSRF guard on `baseUrl` resolves hostnames, and a real lookup would make
  // this suite depend on the network AND answer differently per machine. Every
  // name is public here except the one case that names itself.
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
      // Holds `manage_git` in TEAM_A but is NOT an instance admin - the
      // distinction the private-address gate turns on.
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
  // A bare domain is normalised to an https origin.
  assert.equal(created.baseUrl, "https://git.acme.com");
  assert.equal(created.hasApi, false);
  assert.equal(created.appCount, 0);

  const listed = await asTeamA(() => listGitConnections());
  assert.equal(listed.length, 1);
  // The whole point of a write-only secret: no field of the DTO carries it.
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
  assert.equal((await asTeamA(() => listGitConnections()))[0].label, "Acme git");
});

test("rotating the token replaces it and keeps the rest", async () => {
  const created = await asTeamA(() => connect());
  const updated = await asTeamA(() =>
    updateGitConnection(created.id, { label: "Renamed", token: "new-token" }),
  );
  assert.equal(updated.label, "Renamed");
  assert.equal((await readGitCredential(created.id))?.token, "new-token");

  // An empty token means "keep the stored one", not "erase it".
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
  // Without a credential there is no clone and no delivery, so leaving
  // auto-deploy on would promise something that can no longer happen.
  assert.equal(after?.autoDeploy, false);
  assert.deepEqual(await asTeamA(() => listGitConnections()), []);
});

/* ---- the clone URL ---------------------------------------------------- */

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
  // Deploy logs are readable by anyone with view_logs, a far wider set than the
  // people who may manage the connection.
  assert.equal(
    redactCloneUrl(url),
    "https://git.acme.com/acme/site.git",
  );
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
  // Whatever the encoding, the parsed credentials must come back byte-identical
  // or the clone authenticates as somebody else (or nobody).
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
  // An scp-style remote has nowhere to put basic auth; hand it over untouched
  // rather than mangling it.
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
  // The credential is DROPPED, not honoured: the repo still saves, and clones
  // anonymously instead of with someone else's token.
  const app = await loadAppGraph("prj_1");
  assert.equal(app?.repo?.connectionId ?? null, null);
  assert.equal(app?.repo?.repo, "acme/site");
});

/* ------------------------------------------------------------------ */
/* The address is dialed by the control plane, so it is SSRF surface    */
/* ------------------------------------------------------------------ */

/**
 * `base_url` was the one user-supplied outbound address that never went through
 * the shared guard. That mattered more than the usual blind-SSRF case: the
 * control plane dials it itself to prove the token, and `lib/git/providers.ts`
 * puts the provider's own response body into the error it surfaces - so
 * `http://169.254.169.254/latest/meta-data/` came back READABLE to anyone
 * holding `manage_git`, a team capability.
 *
 * The escape exists because a self-hosted GitLab or Gitea on the operator's LAN
 * is an ordinary thing to want, and it is gated exactly like a private bucket
 * endpoint: instance admin only, and recorded on the row so nobody has to
 * remember who made the exception.
 */

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
    "http://169.254.169.254", // the cloud metadata endpoint
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
  // The politely-spelled version of the same attack. Refusing only the literal
  // would have stopped nothing.
  await assert.rejects(
    () => asTeamA(() => connectTo("https://git.internal.example.com")),
    /private or internal/,
  );
});

test("a private address needs instance admin, not just manage_git", async () => {
  // `user_3` (seeded above) holds the capability in TEAM_A but is not an
  // instance admin, which is the whole distinction: a team capability must never
  // be enough to aim the control plane at its own network.
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
