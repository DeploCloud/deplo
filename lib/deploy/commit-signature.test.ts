import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedPreview,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import {
  seedGithubApp,
  seedGithubInstallation,
} from "../data/infra-test-helpers";
import { encryptSecret } from "../crypto";
import {
  appPreviews,
  deployments,
} from "../db/schema/control-plane/deployments";
import { ContractVersion } from "../agent/gen/agent";
import { signatureOf } from "../github/commits";
import { runDeploymentGuarded } from "./build/deploy-run";

const CLONED = "c".repeat(40);
let db: TestDb;
let pg: PGlite;
let verification: { verified: boolean; reason: string };
const realFetch = globalThis.fetch;

const fakeAgent = () =>
  new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") return undefined;
        if (prop === "close") return () => {};
        if (prop === "hello")
          return async () => ({
            contractVersion: ContractVersion.CONTRACT_VERSION_V1,
            dockerAvailable: true,
            agentVersion: "9.9.9",
            capabilities: ["deploy.network", "git.commit", "deploy.railpack"],
          });
        if (prop === "deploy")
          return async function* () {
            yield {
              seq: 1,
              result: { ready: true, error: "", commitSha: CLONED },
            };
          };
        return async () => ({ ok: true, exists: false, yaml: "", error: "" });
      },
    },
  ) as unknown as AgentConnection;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/access_tokens"))
      return Response.json({ token: "ghs_x", expires_at: "2999-01-01" });
    if (url.endsWith(`/repos/acme/repo/commits/${CLONED}`))
      return Response.json({ sha: CLONED, commit: { verification } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  __setAgentConnectorForTest(async () => fakeAgent());
});

after(async () => {
  globalThis.fetch = realFetch;
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  verification = { verified: true, reason: "valid" };
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams, github_apps restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await seedGithubApp(db, {
    id: "gha_1",
    teamId: TEAM_A,
    privateKeyEnc: encryptSecret(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ),
  });
  await seedGithubInstallation(db, { id: "ghi_1", appId: "gha_1" });
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    slug: "web",
    repo: {
      provider: "github",
      url: "https://github.com/acme/repo",
      repo: "acme/repo",
      branch: "main",
      installationId: "ghi_1",
    },
  });
  await seedPreview(db, {
    id: "prv_1",
    appId: "prj_1",
    prNumber: 1,
    isFork: true,
    approvedAt: "2026-01-01T00:00:00.000Z",
  });
  await db
    .update(appPreviews)
    .set({
      headCloneUrl: "https://github.com/someone/repo.git",
      approvedSha: CLONED,
    })
    .where(eq(appPreviews.id, "prv_1"));
  await seedDeployment(db, {
    id: "dpl_1",
    appId: "prj_1",
    status: "queued",
    previewId: "prv_1",
    prNumber: 1,
    deployKey: "web__pr-1",
  });
});

const storedSignature = async () =>
  (
    await db
      .select({ s: deployments.commitSignature })
      .from(deployments)
      .where(eq(deployments.id, "dpl_1"))
  )[0]?.s;

test("GitHub's verification reads as verified, unverified or nothing", () => {
  assert.equal(signatureOf({ verified: true, reason: "valid" }), "verified");
  assert.equal(
    signatureOf({ verified: false, reason: "unknown_key" }),
    "unverified",
  );
  assert.equal(
    signatureOf({ verified: false, reason: "gpgverify_unavailable" }),
    "unverified",
  );
  assert.equal(signatureOf({ verified: false, reason: "unsigned" }), null);
  assert.equal(signatureOf(undefined), null);
});

test("a preview learns its commit's signature once the build cloned it", async () => {
  await runDeploymentGuarded("dpl_1");
  assert.equal(await storedSignature(), "verified");
});

test("a preview of a commit GitHub rejected is stored as unverified", async () => {
  verification = { verified: false, reason: "bad_email" };
  await runDeploymentGuarded("dpl_1");
  assert.equal(await storedSignature(), "unverified");
});
