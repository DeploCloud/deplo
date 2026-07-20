import {
  activities as activitiesTable,
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import {
  activityToRow,
  githubAppToRow,
  githubInstallationToRow,
  serverToRow,
} from "./infra-rows";
import type { TestDb } from "../db/test-harness";
import type {
  Activity,
  ActivityType,
  GithubApp,
  GithubInstallation,
  Server,
} from "../types";

/**
 * Shared seeding for the infra / integrations cut-set (e) data-layer tests
 * (relational-store PLAN Step 6). `servers`, `github_apps`(+`github_installation`)
 * and `activities` are RELATIONAL: the data layer reads pglite. So
 * this seeds those tables directly, the same way `app-graph-test-helpers` seeds
 * the project graph.
 *
 * Pair with `seedIdentity` (team FKs). Drive the data functions inside
 * `runWithIdentity({ userId, teamId })`.
 *
 * Not named `*.test.ts` so the `node --test` glob skips it (a helper).
 */

const T0 = "2026-01-01T00:00:00.000Z";

/** Truncate every infra/integration table (call in `beforeEach` before seeding). */
export const TRUNCATE_INFRA = `truncate table
  activities, github_installation, github_apps, servers
  restart identity cascade;`;

/** A full {@link Server} with sensible defaults (override any field). */
export function makeServer(opts: Partial<Server> & { id: string }): Server {
  return {
    id: opts.id,
    name: opts.name ?? opts.id,
    host: opts.host ?? "10.0.0.1",
    type: "remote",
    status: opts.status ?? "online",
    ip: opts.ip ?? "10.0.0.1",
    dockerVersion: opts.dockerVersion ?? "27",
    traefikEnabled: opts.traefikEnabled ?? true,
    cpuCores: opts.cpuCores ?? 4,
    memoryMb: opts.memoryMb ?? 8192,
    diskGb: opts.diskGb ?? 100,
    cpuUsage: opts.cpuUsage ?? 1,
    memoryUsage: opts.memoryUsage ?? 1,
    diskUsage: opts.diskUsage ?? 1,
    allTeams: opts.allTeams ?? true,
    deployConcurrency: opts.deployConcurrency ?? 1,
    createdAt: opts.createdAt ?? T0,
    agent: opts.agent,
    bootstrap: opts.bootstrap,
    lastSeenAt: opts.lastSeenAt,
    // Left unset by default = "never health-probed", which is what a freshly seeded
    // server genuinely is. Tests that exercise the prober set them explicitly.
    statusCheckedAt: opts.statusCheckedAt,
    statusMessage: opts.statusMessage,
  };
}

/** Insert a {@link Server} into the relational `servers` table. */
export async function seedServerRow(
  db: TestDb,
  opts: Partial<Server> & { id: string },
): Promise<Server> {
  const server = makeServer(opts);
  await db.insert(serversTable).values(serverToRow(server)).onConflictDoNothing();
  return server;
}

/** Insert a {@link GithubApp} (override any field). Secrets are stored as-is. */
export async function seedGithubApp(
  db: TestDb,
  opts: Partial<GithubApp> & { id: string; teamId: string },
): Promise<GithubApp> {
  const app: GithubApp = {
    id: opts.id,
    teamId: opts.teamId,
    appId: opts.appId ?? 1000,
    slug: opts.slug ?? opts.id,
    name: opts.name ?? opts.id,
    clientId: opts.clientId ?? "client",
    clientSecretEnc: opts.clientSecretEnc ?? "cs_enc",
    webhookSecretEnc: opts.webhookSecretEnc ?? "ws_enc",
    privateKeyEnc: opts.privateKeyEnc ?? "pk_enc",
    htmlUrl: opts.htmlUrl ?? "https://github.com/apps/x",
    createdAt: opts.createdAt ?? T0,
  };
  await db.insert(githubAppsTable).values(githubAppToRow(app));
  return app;
}

/** Insert a {@link GithubInstallation} of a seeded app. */
export async function seedGithubInstallation(
  db: TestDb,
  opts: Partial<GithubInstallation> & { id: string; appId: string },
): Promise<GithubInstallation> {
  const install: GithubInstallation = {
    id: opts.id,
    appId: opts.appId,
    installationId: opts.installationId ?? 5000,
    accountLogin: opts.accountLogin ?? "acct",
    accountType: opts.accountType ?? "Organization",
    avatarUrl: opts.avatarUrl ?? "https://avatars/x",
    createdAt: opts.createdAt ?? T0,
  };
  await db
    .insert(githubInstallationTable)
    .values(githubInstallationToRow(install));
  return install;
}

/** Insert an {@link Activity} (the DB assigns its `seq` in insertion order). */
export async function seedActivity(
  db: TestDb,
  opts: Partial<Activity> & { id: string; teamId: string },
): Promise<Activity> {
  const a: Activity = {
    id: opts.id,
    teamId: opts.teamId,
    type: (opts.type ?? "service") as ActivityType,
    message: opts.message ?? "did a thing",
    actor: opts.actor ?? "owner",
    actorUserId: opts.actorUserId ?? null,
    appId: opts.appId ?? null,
    createdAt: opts.createdAt ?? T0,
  };
  await db.insert(activitiesTable).values(activityToRow(a));
  return a;
}
