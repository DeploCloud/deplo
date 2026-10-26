import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { graphql } from "graphql";

process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { encryptSecret } from "../crypto";
import { nowIso } from "../ids";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { gitConnections } from "../db/schema/control-plane/integrations";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import {
  seedGithubApp,
  seedGithubInstallation,
} from "../data/infra-test-helpers";
import { loadAppGraph } from "../data/app-graph-load";
import {
  __setRunnerForTest,
  __resetQueueForTest,
} from "../deploy/deploy-queue";
import { newRepoAppInput } from "../../components/apps/new-repo-input";
import type { NewRepo } from "../data/new-repos";
import type { GraphQLContext } from "./context";
import { schema } from "./schema";

// The document submitCreatedApp sends, with the input a suggested repository card builds.
const CREATE = /* GraphQL */ `
  mutation ($input: CreateAppInput!) {
    createApp(input: $input) {
      id
      slug
      latestDeployment {
        id
      }
    }
  }
`;

let db: TestDb;
let pg: PGlite;
let ran: string[] = [];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // Settle the row, or the queue picks the same queued deployment again forever.
  __setRunnerForTest(async (depId) => {
    ran.push(depId);
    await db
      .update(deploymentsTable)
      .set({ status: "failed" })
      .where(eq(deploymentsTable.id, depId));
  });
});

after(async () => {
  // The queue's last look for work runs after the final deploy settles; let it finish on this DB.
  await new Promise((r) => setTimeout(r, 200));
  __resetQueueForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table git_connections, github_installation, github_apps, users, teams restart identity cascade;`);
  await seedIdentity(db);
  await seedServer(db);
  await seedGithubApp(db, { id: "gha_1", teamId: TEAM_A });
  await seedGithubInstallation(db, { id: "ghi_1", appId: "gha_1" });
  await db.insert(gitConnections).values({
    id: "gitc_1",
    teamId: TEAM_A,
    provider: "gitea",
    label: "Acme Gitea",
    baseUrl: "https://git.acme.com",
    username: "deplo",
    tokenEnc: encryptSecret("t"),
    webhookSecretEnc: encryptSecret("w"),
    webhookToken: "wht_1",
    createdAt: nowIso(),
    createdBy: USER_1,
  });
  ran = [];
});

const identity: RequestIdentity = { userId: USER_1, teamId: TEAM_A };

async function clickCard(repo: NewRepo) {
  const { input } = newRepoAppInput(repo);
  return runWithIdentity(identity, async () => {
    const ctx: GraphQLContext = {
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity: null,
    };
    const res = await graphql({
      schema,
      source: CREATE,
      variableValues: { input },
      contextValue: ctx,
    });
    assert.deepEqual(res.errors ?? [], [], "the card's input is refused");
    const created = (
      res.data as {
        createApp: {
          id: string;
          slug: string;
          latestDeployment: { id: string } | null;
        };
      }
    ).createApp;
    return { created, app: await loadAppGraph(created.id) };
  });
}

const repo = (over: Partial<NewRepo>): NewRepo => ({
  provider: "github",
  fullName: "acme/shop",
  name: "shop",
  defaultBranch: "trunk",
  url: "https://github.com/acme/shop",
  private: true,
  createdAt: nowIso(),
  installationId: null,
  connectionId: null,
  ...over,
});

test("a GitHub card creates a deployed app that clones with its installation", async () => {
  const { created, app } = await clickCard(repo({ installationId: "ghi_1" }));
  assert.ok(app);
  assert.equal(app.name, "Shop");
  assert.equal(app.source, "github");
  assert.equal(app.repo?.installationId, "ghi_1");
  assert.equal(
    app.repo?.branch,
    "trunk",
    "the repository's own default branch",
  );
  assert.equal(app.build.methodAuto, true, "the build method is detected");
  assert.equal(app.autoDeploy, true);
  assert.ok(created.latestDeployment, "the first deploy was started");
  for (let i = 0; i < 50 && ran.length === 0; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    ran,
    [created.latestDeployment.id],
    "handed to the runner once",
  );
  const domains = await db
    .select({ name: domainsTable.name })
    .from(domainsTable)
    .where(eq(domainsTable.appId, created.id));
  assert.equal(domains.length, 1, "it gets an address of its own");
});

test("a card from another host keeps its connection, so a private repository clones", async () => {
  const { app } = await clickCard(
    repo({
      provider: "gitea",
      url: "https://git.acme.com/acme/shop",
      connectionId: "gitc_1",
    }),
  );
  assert.ok(app);
  assert.equal(app.source, "git");
  assert.equal(app.repo?.provider, "gitea");
  assert.equal(app.repo?.connectionId, "gitc_1");
});

test("clicking a second time makes a second app under its own name, never a clash", async () => {
  const first = await clickCard(repo({ installationId: "ghi_1" }));
  const second = await clickCard(repo({ installationId: "ghi_1" }));
  assert.notEqual(first.created.slug, second.created.slug);
});
