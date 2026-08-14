import { eq } from "drizzle-orm";

import {
  deployments as deploymentsTable,
  apps as appsTable,
  appBuild as appBuildTable,
  appBuildMethodSettings as appBuildMethodSettingsTable,
  appPreviews as appPreviewsTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { buildConfigFor } from "../frameworks";
import {
  buildToRow,
  deploymentToRow,
  methodSettingsToRow,
  appToRow,
} from "./app-graph-rows";
import type { TestDb } from "../db/test-harness";
import { DEFAULT_ROLLBACK_KEEP } from "../types";
import type { Deployment, App } from "../types";
import { TEAM_A, USER_1 } from "./identity-test-helpers";

/**
 * Shared seeding for the app-graph cut-set (c) data-layer tests
 * (relational-store PLAN Step 4). The project graph is RELATIONAL: the data layer
 * + the deploy engine read pglite. So this seeds a server + project (with its
 * 1-to-1 build / method-settings rows) and any deployments directly into the
 * relational tables, the same way `identity-test-helpers` seeds identity.
 *
 * Pair it with `seedIdentity` (the project's `team_id` FK needs a real team) and
 * drive the data functions inside `runWithIdentity({ userId, teamId })`.
 *
 * Not named `*.test.ts` so the `node --test` glob skips it (a helper).
 */

export const SERVER_1 = "srv_1";
const T0 = "2026-01-01T00:00:00.000Z";

/** Truncate every app-graph table (call in `beforeEach` before seeding). */
export const TRUNCATE_PROJECT_GRAPH = `truncate table
  team_app_order, team_folder_order,
  shared_env_var_apps, shared_env_var_projects, shared_env_var_environments,
  shared_env_var_targets, shared_env_vars,
  deployment_logs, deployments, env_var_targets, env_vars,
  domain_middlewares, domains,
  app_mounts, app_volumes, app_preview_env_vars, app_previews,
  app_build_method_settings, app_build, apps,
  folders, servers
  restart identity cascade;`;

/** The app's slug, for defaulting a seeded deployment's deploy key. */
async function appSlug(db: TestDb, appId: string): Promise<string> {
  const rows = await db
    .select({ slug: appsTable.slug })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  return rows[0]?.slug ?? appId;
}

/** Seed the instance-wide server row a project's `server_id` FK references. */
export async function seedServer(db: TestDb, id: string = SERVER_1): Promise<void> {
  await db
    .insert(serversTable)
    .values({
      id,
      name: id,
      host: "10.0.0.1",
      type: "remote",
      status: "online",
      ip: "10.0.0.1",
      dockerVersion: "27",
      traefikEnabled: true,
      cpuCores: 4,
      memoryMb: 8192,
      diskGb: 100,
      cpuUsage: 1,
      memoryUsage: 1,
      diskUsage: 1,
      createdAt: T0,
    })
    .onConflictDoNothing();
}

export interface SeedAppOpts {
  id: string;
  teamId?: string;
  serverId?: string;
  slug?: string;
  status?: App["status"];
  source?: App["source"];
  resources?: App["resources"];
  /** How many previous deployments this app can be rolled back to. */
  rollbackKeep?: number;
  /** Compose YAML — pair with `source: "compose"` to seed a compose-stack app. */
  compose?: string | null;
  /** Park the app inside a folder (seed the folder row yourself first). */
  folderId?: string | null;
  /** File the app under a Project container (seed the project row yourself). */
  projectId?: string | null;
  environmentId?: string | null;
  /**
   * Authorship — NOT on the App type (it never reaches the renderer), so it is
   * written straight onto the row, exactly as `createApp` does.
   */
  createdByUserId?: string | null;
  /** Pin the app to a build server (seed that server row first). */
  buildServerId?: string | null;
  /** Turn OFF "build here if the build server is unreachable". */
  buildFallbackLocal?: boolean;
}

/** Seed one project + its 1-to-1 build / method-settings rows. Returns the id. */
export async function seedApp(
  db: TestDb,
  opts: SeedAppOpts,
): Promise<string> {
  const teamId = opts.teamId ?? TEAM_A;
  const serverId = opts.serverId ?? SERVER_1;
  const build = buildConfigFor({});
  const project: App = {
    id: opts.id,
    name: opts.id,
    slug: opts.slug ?? opts.id,
    teamId,
    folderId: opts.folderId ?? null,
    projectId: opts.projectId ?? null,
    environmentId: opts.environmentId ?? null,
    serverId,
    buildServerId: opts.buildServerId ?? null,
    buildFallbackLocal: opts.buildFallbackLocal ?? true,
    logo: null,
    frameworkOverride: null,
    framework: null,
    source: opts.source ?? "github",
    repo: { provider: "github", url: "https://x", repo: "o/r", branch: "main" },
    dockerImage: null,
    upload: null,
    compose: opts.compose ?? null,
    mounts: null,
    volumes: null,
    build,
    productionUrl: null,
    status: opts.status ?? "active",
    previewEnabled: false,
    cronEnabled: false,
    autoDeploy: true,
    deployHookEnabled: true,
    composeUpArgs: null,
    rollbackKeep: opts.rollbackKeep ?? DEFAULT_ROLLBACK_KEEP,
    resources: opts.resources ?? null,
    latestDeploymentId: null,
    createdAt: T0,
    updatedAt: T0,
  };
  await db
    .insert(appsTable)
    .values({ ...appToRow(project), createdByUserId: opts.createdByUserId ?? null });
  await db.insert(appBuildTable).values(buildToRow(project.id, build));
  await db
    .insert(appBuildMethodSettingsTable)
    .values(methodSettingsToRow(project.id, build.methodSettings));
  return project.id;
}

/** Seed a deployment row for a project. `serverId` denormalizes the owning server
 *  onto the row (what the deploy queue drains on) — omit to leave it null. */
export async function seedDeployment(
  db: TestDb,
  opts: {
    id: string;
    appId: string;
    status?: Deployment["status"];
    createdAt?: string;
    /** When the build was claimed off the queue — omit to leave it null (a row
     *  that never started building). */
    startedAt?: string;
    serverId?: string;
    /** Defaults to production. A preview row also needs `deployKey`/`previewId`. */
    environment?: Deployment["environment"];
    /** The stack this deploy owns. Defaults to the app slug (what production
     *  deploys always used); a preview passes `<slug>__pr-<n>`. */
    deployKey?: string;
    previewId?: string | null;
    prNumber?: number | null;
    /** The image this deploy rendered - set it to make the row a rollback target
     *  (a build Deplo made), or leave it null for a compose / prebuilt-image one. */
    imageRef?: string | null;
    /** Mark the row as a rollback TO another deployment (so it occupies no
     *  retention slot of its own). */
    rollbackOf?: string | null;
    /** The server this deploy BUILT on, when that was not `serverId`. */
    buildServerId?: string | null;
  },
): Promise<void> {
  const dep: Deployment = {
    id: opts.id,
    appId: opts.appId,
    status: opts.status ?? "ready",
    forceRecreate: false,
    serverId: opts.serverId ?? SERVER_1,
    buildServerId: opts.buildServerId ?? null,
    environment: opts.environment ?? "production",
    // Defaults to the app's slug, which is what every production deploy uses.
    // Seeders that don't care never have to think about the key.
    deployKey: opts.deployKey ?? (await appSlug(db, opts.appId)),
    previewId: opts.previewId ?? null,
    prNumber: opts.prNumber ?? null,
    commitSha: "",
    commitMessage: "deploy",
    commitAuthor: "Owner",
    branch: "main",
    url: "https://x",
    createdAt: opts.createdAt ?? T0,
    startedAt: opts.startedAt ?? null,
    readyAt: null,
    buildDurationMs: null,
    imageRef: opts.imageRef ?? null,
    rollbackOf: opts.rollbackOf ?? null,
    creator: "Owner",
  };
  await db
    .insert(deploymentsTable)
    .values({
      ...deploymentToRow(dep),
      serverId: opts.serverId ?? null,
      buildServerId: opts.buildServerId ?? null,
    });
}

/** Seed a pull request preview row for an app. Defaults to an open, same-repo
 *  preview whose deploy key and host follow the real minting rules. */
export async function seedPreview(
  db: TestDb,
  opts: {
    id: string;
    appId: string;
    prNumber: number;
    deployKey?: string;
    host?: string;
    status?: string;
    state?: "open" | "closed";
    isFork?: boolean;
    headRepo?: string;
    approvedAt?: string | null;
    lastActivityAt?: string;
    closedAt?: string | null;
    tornDownAt?: string | null;
  },
): Promise<void> {
  const slug = await appSlug(db, opts.appId);
  await db.insert(appPreviewsTable).values({
    id: opts.id,
    appId: opts.appId,
    prNumber: opts.prNumber,
    prTitle: `Pull request ${opts.prNumber}`,
    prAuthor: "octocat",
    prUrl: `https://github.com/acme/repo/pull/${opts.prNumber}`,
    headBranch: `feat/pr-${opts.prNumber}`,
    headSha: "",
    headRepo: opts.headRepo ?? "",
    headCloneUrl: "",
    baseBranch: "main",
    isFork: opts.isFork ?? false,
    approvedAt: opts.approvedAt ?? null,
    deployKey: opts.deployKey ?? `${slug}__pr-${opts.prNumber}`,
    host: opts.host ?? `${slug}-pr-${opts.prNumber}.example.test`,
    certProvider: "none",
    status: opts.status ?? "active",
    url: "",
    state: opts.state ?? "open",
    closedAt: opts.closedAt ?? null,
    tornDownAt: opts.tornDownAt ?? null,
    lastActivityAt: opts.lastActivityAt ?? T0,
    createdAt: T0,
    updatedAt: T0,
  });
}

export { TEAM_A, USER_1 };
