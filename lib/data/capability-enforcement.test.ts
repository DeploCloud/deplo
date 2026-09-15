import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  deployments as deploymentsTable,
  deploymentLogs as deploymentLogsTable,
} from "../db/schema/control-plane/deployments";
import { teams as teamsTable } from "../db/schema/control-plane/identity";
import { folders as foldersTable } from "../db/schema/control-plane/projects";
import { runWithIdentity, type TokenGrant } from "../auth/request-context";
import { ALL_CAPABILITIES, type Capability } from "../types/identity";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import {
  __resetQueueForTest,
  __setRunnerForTest,
} from "../deploy/deploy-queue";

import { createApp } from "./apps/create";
import { getLogs } from "./deployments/build-progress";
import { redeploy } from "./deployments/stack-actions";
import { listActivity, recordActivity } from "./activity";
import { getAppMetrics, getAppMetricsHistory } from "./container-metrics";
import {
  getLogsInfo,
  resolveAttachTarget,
  resolveLogsTarget,
  setConsoleEnabled,
} from "./console";
import { resolveDatabaseLogsTarget } from "./database-console";
import { listEnv, upsertEnv } from "./env";
import { deleteTeam } from "./team-delete";
import { setFolderGrant } from "./folder-access";
import { authenticateToken } from "./tokens/authenticate";
import { createToken } from "./tokens/mint";
import {
  verifyDeployHookToken,
  revealDeployHook,
  owningTeamId,
} from "./deploy-hook";
import { appInTeam } from "./app-graph-load";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";

const OWNER = "u_owner";
const NO_READS = "u_no_reads";
const CREATOR = "u_creator";
const DEPLOYER = "u_deployer";
const ENV_ONLY = "u_env";

const APP = "prj_1";
const DEP = "dpl_1";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setRunnerForTest(async () => {});
});

after(async () => {
  __resetQueueForTest();
  __resetTestDb();
  await pg.close();
});

const READ_CAPS: Capability[] = ["view_logs", "view_metrics", "view_activity"];
const allBut = (...without: Capability[]): Capability[] =>
  ALL_CAPABILITIES.filter((c) => !without.includes(c));

beforeEach(async () => {
  await pg.exec(`truncate table databases restart identity cascade;`);
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(`truncate table
    activities, api_tokens, projects, membership_capabilities, memberships,
    users, teams, instance_settings restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      {
        id: NO_READS,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: allBut(...READ_CAPS),
      },
      {
        id: CREATOR,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "create_apps"],
      },
      {
        id: DEPLOYER,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "create_apps", "deploy_apps"],
      },
      {
        id: ENV_ONLY,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "manage_env"],
      },
      { id: "u_other_team", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A });
  await seedDatabase(db, { id: "db_1", name: "main" });
  await seedDeployment(db, { id: DEP, appId: APP });
  await db.insert(deploymentLogsTable).values({
    deploymentId: DEP,
    ts: T0,
    level: "info",
    text: "AWS_SECRET_ACCESS_KEY=hunter2",
  });
});

const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

const asToken = <T>(
  userId: string,
  capabilities: Capability[],
  fn: () => Promise<T>,
  over: Partial<TokenGrant> = {},
): Promise<T> =>
  runWithIdentity(
    {
      userId,
      teamId: TEAM_A,
      token: {
        id: "tok_t",
        capabilities,
        scope: null,
        instanceAdmin: false,
        ...over,
      },
    },
    fn,
  );

async function outcome(
  fn: () => Promise<unknown>,
): Promise<"refused" | "allowed"> {
  try {
    await fn();
    return "allowed";
  } catch (e) {
    const m = (e as Error).message;
    if (/permission|not found|Unauthorized|can't|cannot|only /i.test(m))
      return "refused";
    throw e;
  }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "gen" && name !== "node_modules") sourceFiles(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

test("every capability is enforced in the data layer", () => {
  const CATALOG = [
    "lib/capabilities.ts",
    "lib/types/identity.ts",
    "lib/token-presets.ts",
    "lib/membership-shared.ts",
  ];
  const files = [
    ...sourceFiles("lib/data"),
    "lib/membership.ts",
    ...sourceFiles("lib/deploy"),
  ].filter((f) => !CATALOG.includes(f));
  const corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");

  const dead = ALL_CAPABILITIES.filter((c) => !corpus.includes(`"${c}"`));
  assert.deepEqual(
    dead,
    [],
    `these capabilities can be granted but are never checked - the checkbox is a lie: ${dead.join(", ")}`,
  );
});

test("view_logs gates a deployment's build log", async () => {
  const forOwner = await as(OWNER, () => getLogs(DEP));
  assert.equal(forOwner.length, 1, "the control: a full member reads the log");

  assert.deepEqual(
    await as(NO_READS, () => getLogs(DEP)),
    [],
    "a build log carries build-time variables - without view_logs it must not be readable",
  );
});

test("the console switch gates attach, not only the sidebar chip", async () => {
  assert.deepEqual(await as(OWNER, () => resolveAttachTarget(APP)), {
    ok: false,
    reason: "not-found",
  });

  await as(OWNER, () => setConsoleEnabled(APP, true));
  const on = await as(OWNER, () => resolveAttachTarget(APP));
  assert.notEqual(
    on.ok ? "ok" : on.reason,
    "not-found",
    "with the switch on the gate is past, and only the (absent) host stops it",
  );

  await as(OWNER, () => setConsoleEnabled(APP, false));
  assert.deepEqual(await as(OWNER, () => resolveAttachTarget(APP)), {
    ok: false,
    reason: "not-found",
  });
});

test("view_logs gates the live container log stream", async () => {
  const denied = await as(NO_READS, () => resolveLogsTarget(APP));
  assert.deepEqual(denied, { ok: false, reason: "forbidden" });

  const allowed = await as(OWNER, () => resolveLogsTarget(APP));
  assert.notEqual(
    allowed.ok ? "ok" : allowed.reason,
    "forbidden",
    "a member holding view_logs is stopped by the host, not by the gate",
  );
});

test("view_logs gates a database's log stream too", async () => {
  const denied = await as(NO_READS, () => resolveDatabaseLogsTarget("db_1"));
  assert.deepEqual(denied, { ok: false, reason: "forbidden" });
});

test("view_logs gates the logs viewer's instance list", async () => {
  assert.equal(
    await as(NO_READS, () => getLogsInfo(APP)),
    null,
    "no view_logs ⇒ the log viewer resolves nothing at all",
  );
});

test("view_activity gates the audit trail", async () => {
  await as(OWNER, () => recordActivity("app", "Did a thing", "owner", APP));

  assert.ok(
    (await as(OWNER, () => listActivity())).length > 0,
    "the control: a member holding view_activity reads the trail",
  );
  assert.deepEqual(
    await as(NO_READS, () => listActivity()),
    [],
    "the audit trail is who-did-what across the whole team - view_activity must gate it",
  );
});

test("view_metrics gates the monitoring reads", async () => {
  await as(NO_READS, async () => {
    assert.equal(await getAppMetrics(APP), null);
    assert.deepEqual(await getAppMetricsHistory(APP), []);
  });
});

const deploymentsOf = async (appId: string) =>
  db.select().from(deploymentsTable).where(eq(deploymentsTable.appId, appId));

test("create_apps alone creates the app but ships nothing", async () => {
  const app = await as(CREATOR, () =>
    createApp({
      name: "Created",
      source: "docker-image",
      repo: null,
      dockerImage: "nginx:1.27",
    }),
  );
  assert.equal(
    (await deploymentsOf(app.id)).length,
    0,
    "creating an app must not be a way to deploy without deploy_apps",
  );
  const row = (
    await db.select().from(appsTable).where(eq(appsTable.id, app.id))
  )[0]!;
  assert.equal(
    row.status,
    "idle",
    "the app is born idle, waiting for someone who can ship it",
  );
});

test("create_apps + deploy_apps creates AND ships", async () => {
  const app = await as(DEPLOYER, () =>
    createApp({
      name: "Shipped",
      source: "docker-image",
      repo: null,
      dockerImage: "nginx:1.27",
    }),
  );
  assert.equal(
    (await deploymentsOf(app.id)).length,
    1,
    "the normal path is unchanged: whoever can deploy gets their first deploy on create",
  );
});

test("create_apps is not permission to claim a hostname", async () => {
  await as(CREATOR, async () => {
    assert.equal(
      await outcome(() =>
        createApp({
          name: "Squatter",
          source: "docker-image",
          repo: null,
          dockerImage: "nginx:1.27",
          autoDomain: "shop.example.com",
        }),
      ),
      "refused",
      "a hostname is unique instance-wide: taking one is manage_domains, not create_apps",
    );
    assert.equal(
      await outcome(() =>
        createApp({
          name: "Squatter extra",
          source: "docker-image",
          repo: null,
          dockerImage: "nginx:1.27",
          extraDomains: [{ host: "api.example.com", port: 80, service: "web" }],
        }),
      ),
      "refused",
      "and the extras go the same way the primary does",
    );
    const fromTemplate = await createApp({
      name: "From template",
      source: "docker-image",
      repo: null,
      dockerImage: "nginx:1.27",
      autoDomain: "app-blue-otter-7f000001.nip.io",
    });
    assert.ok(fromTemplate.id);
  });
});

test("a member without create_apps cannot create at all", async () => {
  await as(ENV_ONLY, async () => {
    assert.equal(
      await outcome(() =>
        createApp({ name: "Nope", source: "upload", repo: null }),
      ),
      "refused",
    );
  });
});

test("nobody reads a secret back, not even the owner", async () => {
  await as(OWNER, () =>
    upsertEnv({ appId: APP, key: "API_KEY", value: "s3cr3t", type: "secret" }),
  );

  for (const actor of [OWNER, ENV_ONLY]) {
    const [row] = await as(actor, () => listEnv(APP));
    assert.equal(row!.masked, true);
    assert.notEqual(
      row!.value,
      "s3cr3t",
      `${actor} must not see the plaintext`,
    );
  }

  await assert.rejects(
    () =>
      as(ENV_ONLY, () =>
        upsertEnv({
          appId: APP,
          key: "API_KEY",
          value: "••••••••••••",
          type: "plain",
        }),
      ),
    /cannot be edited/i,
  );
  assert.equal((await as(OWNER, () => listEnv(APP)))[0]!.masked, true);
});

test("delete_team gates deleting the team, even for the founder", async () => {
  await db.insert(teamsTable).values({
    id: "team_second",
    name: "Second",
    slug: "second",
    plan: "free",
    founderUserId: null,
    createdAt: T0,
  });
  await db
    .insert(
      (await import("../db/schema/control-plane/access-control")).memberships,
    )
    .values({
      id: "mem_second",
      userId: OWNER,
      teamId: "team_second",
      role: "owner",
      createdAt: T0,
    });
  await db
    .update(teamsTable)
    .set({ founderUserId: OWNER })
    .where(eq(teamsTable.id, TEAM_A));
  await pg.exec(
    `delete from membership_capabilities where capability = 'delete_team';`,
  );
  await pg.exec(
    `update users set is_instance_admin = false where id = '${OWNER}';`,
  );

  await as(OWNER, async () => {
    assert.equal(
      await outcome(() => deleteTeam(TEAM_A)),
      "refused",
      "being the founder is not the same as holding the permission to destroy the team",
    );
  });
  assert.ok(
    (await db.select().from(teamsTable).where(eq(teamsTable.id, TEAM_A)))
      .length === 1,
    "the team survived",
  );
});

test("a token can never exceed its own capability set", async () => {
  await asToken(OWNER, ["view"], async () => {
    assert.equal(await outcome(() => redeploy(APP)), "refused");
    assert.deepEqual(await getLogs(DEP), []);
    assert.equal(
      await outcome(() =>
        upsertEnv({ appId: APP, key: "NOPE", value: "x", type: "plain" }),
      ),
      "refused",
    );
  });
});

test("a read-only token cannot delete its creator's team", async () => {
  await db.insert(teamsTable).values({
    id: "team_third",
    name: "Third",
    slug: "third",
    plan: "free",
    founderUserId: null,
    createdAt: T0,
  });
  await db
    .insert(
      (await import("../db/schema/control-plane/access-control")).memberships,
    )
    .values({
      id: "mem_third",
      userId: OWNER,
      teamId: "team_third",
      role: "owner",
      createdAt: T0,
    });
  await db
    .update(teamsTable)
    .set({ founderUserId: OWNER })
    .where(eq(teamsTable.id, TEAM_A));
  await pg.exec(
    `update users set is_instance_admin = false where id = '${OWNER}';`,
  );

  await asToken(
    OWNER,
    ["view", "view_logs", "view_metrics", "view_activity"],
    async () => {
      assert.equal(
        await outcome(() => deleteTeam(TEAM_A)),
        "refused",
        "a Read only token minted by the founder must not be able to destroy the team",
      );
    },
  );
});

test("instance-admin is per-token: a plain token minted by an admin is not an admin", async () => {
  await db.insert(foldersTable).values({
    id: "fld_private",
    teamId: TEAM_A,
    name: "Private",
    parentId: null,
    color: null,
    ownerUserId: ENV_ONLY,
    createdAt: T0,
    updatedAt: T0,
  });

  await as(OWNER, () =>
    setFolderGrant("fld_private", CREATOR, ["deploy_apps"]),
  );

  // Everything EXCEPT manage_team, which makes any member a folder super-user and would mask the question.
  await asToken(OWNER, allBut("manage_team"), async () => {
    assert.equal(
      await outcome(() =>
        setFolderGrant("fld_private", DEPLOYER, ["deploy_apps"]),
      ),
      "refused",
      "a token that was not given instance-admin cannot administer someone else's folder",
    );
  });

  await asToken(
    OWNER,
    allBut("manage_team"),
    () => setFolderGrant("fld_private", DEPLOYER, ["deploy_apps"]),
    { instanceAdmin: true },
  );
});

test("a token holding a capability its creator has lost is refused", async () => {
  await asToken(ENV_ONLY, ["view", "deploy_apps"], async () => {
    assert.equal(await outcome(() => redeploy(APP)), "refused");
  });
});

test("a node grant reaches a token only through the token's own set", async () => {
  await db.insert(foldersTable).values({
    id: "fld_shared",
    teamId: TEAM_A,
    name: "Shared",
    parentId: null,
    color: null,
    ownerUserId: OWNER,
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .update(appsTable)
    .set({ folderId: "fld_shared" })
    .where(eq(appsTable.id, APP));
  await as(OWNER, () =>
    setFolderGrant("fld_shared", ENV_ONLY, ["deploy_apps", "view_logs"]),
  );

  assert.equal((await as(ENV_ONLY, () => getLogs(DEP))).length, 1);
  assert.deepEqual(
    await asToken(ENV_ONLY, ["view"], () => getLogs(DEP)),
    [],
    "a grant widens the PERSON, never the credential",
  );
});

test("a project-scoped token loses the team-wide capabilities", async () => {
  const scope = {
    teamIds: [TEAM_A],
    wholeTeamIds: [],
    projectIds: ["prc_none"],
    folderIds: [],
    appIds: [],
    appProjectIds: [],
  };
  await asToken(
    OWNER,
    [...ALL_CAPABILITIES],
    async () => {
      assert.equal(await outcome(() => redeploy(APP)), "refused");
      assert.deepEqual(await getLogs(DEP), []);
    },
    { scope },
  );
});

test("a minted token's capabilities are clamped to its creator at mint time", async () => {
  const { raw } = await as(ENV_ONLY, () =>
    createToken({ name: "over-reaching", capabilities: [...ALL_CAPABILITIES] }),
  ).catch(() => ({ raw: "" }));
  assert.equal(raw, "", "minting a token needs manage_tokens");

  const minted = await as(OWNER, () =>
    createToken({
      name: "ci",
      capabilities: ["view", "deploy_apps"],
    }),
  );
  const principal = await authenticateToken(minted.raw, TEAM_A);
  assert.ok(principal?.token);
  assert.deepEqual(principal!.token!.capabilities, ["view", "deploy_apps"]);
});

async function hookCall(
  raw: string,
  appId: string,
  urlToken: string,
): Promise<"401" | "404" | "403-disabled" | "refused" | "deployed"> {
  const principal = await authenticateToken(
    raw,
    await owningTeamId(appId),
  ).catch(() => null);
  if (!principal) return "401";
  const unreachable = await runWithIdentity(
    principal,
    async () => !(await appInTeam(appId, principal.teamId)),
  );
  if (unreachable) return "404";
  const hook = await verifyDeployHookToken(appId, urlToken);
  if (!hook.ok) return hook.reason === "disabled" ? "403-disabled" : "404";
  if (hook.teamId !== principal.teamId) return "404";
  try {
    await runWithIdentity(principal, () => redeploy(appId));
    return "deployed";
  } catch {
    return "refused";
  }
}

test("a deploy hook needs BOTH secrets and the deploy permission", async () => {
  const url = await as(OWNER, () => revealDeployHook(APP));
  const urlToken = url.slice(url.lastIndexOf("/") + 1);

  const ci = await as(OWNER, () =>
    createToken({ name: "ci", capabilities: ["view", "deploy_apps"] }),
  );
  const ro = await as(OWNER, () =>
    createToken({ name: "ro", capabilities: ["view"] }),
  );

  assert.equal(await hookCall(ci.raw, APP, urlToken), "deployed");
  assert.equal(
    await hookCall(ro.raw, APP, urlToken),
    "refused",
    "the URL is not an authorization - a token without deploy_apps deploys nothing",
  );
  assert.equal(
    await hookCall(ci.raw, APP, "wrong-token"),
    "404",
    "a valid API token does not make a wrong URL work",
  );
  assert.equal(await hookCall("deplo_nope", APP, urlToken), "401");
});

test("a deploy hook cannot cross to another team's app", async () => {
  await seedApp(db, { id: "prj_other", teamId: TEAM_B, slug: "other" });
  const url = await as(OWNER, () => revealDeployHook(APP));
  const urlToken = url.slice(url.lastIndexOf("/") + 1);
  const ci = await as(OWNER, () =>
    createToken({ name: "ci", capabilities: ["view", "deploy_apps"] }),
  );
  assert.equal(
    await hookCall(ci.raw, "prj_other", urlToken),
    "404",
    "a token for team A must not learn anything about team B's apps",
  );
});

test("a revoked hook URL stops deploying immediately", async () => {
  const url = await as(OWNER, () => revealDeployHook(APP));
  const old = url.slice(url.lastIndexOf("/") + 1);
  const ci = await as(OWNER, () =>
    createToken({ name: "ci", capabilities: ["view", "deploy_apps"] }),
  );
  assert.equal(await hookCall(ci.raw, APP, old), "deployed");

  await as(OWNER, async () => {
    const { rotateDeployHook } = await import("./deploy-hook");
    await rotateDeployHook(APP);
  });
  assert.equal(await hookCall(ci.raw, APP, old), "404");
});

test("opening a hook's URL needs configure_apps, not just membership", async () => {
  await as(ENV_ONLY, async () => {
    assert.equal(await outcome(() => revealDeployHook(APP)), "refused");
  });
});

test("a suspended member's token stops working everywhere", async () => {
  const ci = await as(OWNER, () =>
    createToken({ name: "ci", capabilities: ["view", "deploy_apps"] }),
  );
  await pg.exec(`update users set suspended = true where id = '${OWNER}';`);

  const principal = await authenticateToken(ci.raw, TEAM_A);
  assert.ok(
    principal,
    "the row still resolves - the account check is downstream",
  );
  await runWithIdentity(principal!, async () => {
    assert.equal(await outcome(() => redeploy(APP)), "refused");
    await assert.rejects(() => listActivity());
  });
});

test("an unmet two-factor policy refuses a token, with a reason", async () => {
  const ci = await as(OWNER, () =>
    createToken({ name: "ci", capabilities: ["view", "deploy_apps"] }),
  );
  await db
    .update(teamsTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamsTable.id, TEAM_A));

  await assert.rejects(
    () => authenticateToken(ci.raw, TEAM_A),
    /two-factor/i,
    "the credential is refused, and says why - a CI job must not get a bare 500",
  );
  assert.equal(await hookCall(ci.raw, APP, "whatever"), "401");
});
