import { eq } from "drizzle-orm";

import {
  apps as appsTable,
  appBuild as appBuildTable,
  appBuildMethodSettings as appBuildMethodSettingsTable,
} from "../db/schema/control-plane/apps";
import {
  deployments as deploymentsTable,
  appPreviews as appPreviewsTable,
} from "../db/schema/control-plane/deployments";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { buildConfigFor } from "../frameworks";
import { appToRow } from "./app-graph-rows/app";
import { buildToRow, methodSettingsToRow } from "./app-graph-rows/build";
import { deploymentToRow } from "./app-graph-rows/deployment";
import type { TestDb } from "../db/test-harness";
import { DEFAULT_ROLLBACK_KEEP } from "../types/app";
import type { App } from "../types/app";
import type { HealthCheck } from "../types/container";
import type { Deployment } from "../types/deployment";
import { TEAM_A, USER_1 } from "./identity-test-helpers";

export const SERVER_1 = "srv_1";
const T0 = "2026-01-01T00:00:00.000Z";

export const TRUNCATE_PROJECT_GRAPH = `truncate table
  team_app_order, team_folder_order,
  shared_env_var_apps, shared_env_var_projects, shared_env_var_environments,
  shared_env_var_targets, shared_env_vars,
  deployment_logs, deployments, env_var_targets, env_vars,
  domain_middlewares, domains,
  app_mounts, app_volumes, app_ports, app_preview_env_vars, app_previews,
  app_build_method_settings, app_build, apps,
  folders, servers
  restart identity cascade;`;

async function appSlug(db: TestDb, appId: string): Promise<string> {
  const rows = await db
    .select({ slug: appsTable.slug })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  return rows[0]?.slug ?? appId;
}

export async function seedServer(
  db: TestDb,
  id: string = SERVER_1,
  opts: { provisioned?: boolean } = {},
): Promise<void> {
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
      ...(opts.provisioned
        ? { agentPort: 9443, agentCertFingerprint: `fp-${id}` }
        : {}),
      traefikEnabled: true,
      cpuCores: 4,
      memoryMb: 8192,
      diskGb: 100,
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
  repo?: App["repo"];
  resources?: App["resources"];
  rollbackKeep?: number;
  compose?: string | null;
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  createdByUserId?: string | null;
  buildServerId?: string | null;
  buildFallback?: boolean;
  healthCheck?: HealthCheck | null;
}

export async function seedApp(db: TestDb, opts: SeedAppOpts): Promise<string> {
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
    dataCopyError: "",
    migrationRunId: null,
    buildServerId: opts.buildServerId ?? null,
    buildFallback: opts.buildFallback ?? true,
    logo: null,
    logoTone: null,
    frameworkOverride: null,
    framework: null,
    source: opts.source ?? "github",
    repo:
      opts.repo !== undefined
        ? opts.repo
        : { provider: "github", url: "https://x", repo: "o/r", branch: "main" },
    dockerImage: null,
    upload: null,
    compose: opts.compose ?? null,
    mounts: null,
    volumes: null,
    ports: null,
    build,
    productionUrl: null,
    status: opts.status ?? "active",
    previewEnabled: false,
    cronEnabled: false,
    restartLoopGuard: true,
    consoleEnabled: false,
    autoDeploy: true,
    deployHookEnabled: true,
    composeUpArgs: null,
    rollbackKeep: opts.rollbackKeep ?? DEFAULT_ROLLBACK_KEEP,
    resources: opts.resources ?? null,
    healthCheck: opts.healthCheck ?? null,
    latestDeploymentId: null,
    createdAt: T0,
    updatedAt: T0,
  };
  await db.insert(appsTable).values({
    ...appToRow(project),
    createdByUserId: opts.createdByUserId ?? null,
  });
  await db.insert(appBuildTable).values(buildToRow(project.id, build));
  await db
    .insert(appBuildMethodSettingsTable)
    .values(methodSettingsToRow(project.id, build.methodSettings));
  return project.id;
}

export async function seedDeployment(
  db: TestDb,
  opts: {
    id: string;
    appId: string;
    status?: Deployment["status"];
    createdAt?: string;
    startedAt?: string;
    serverId?: string;
    environment?: Deployment["environment"];
    deployKey?: string;
    previewId?: string | null;
    prNumber?: number | null;
    imageRef?: string | null;
    rollbackOf?: string | null;
    buildServerId?: string | null;
    creatorUserId?: string | null;
    creatorProvider?: string | null;
  },
): Promise<void> {
  const dep: Deployment = {
    id: opts.id,
    appId: opts.appId,
    status: opts.status ?? "ready",
    forceRecreate: false,
    creatorUserId: opts.creatorUserId ?? null,
    creatorUser: null,
    creatorProvider: opts.creatorProvider ?? null,
    serverId: opts.serverId ?? SERVER_1,
    buildServerId: opts.buildServerId ?? null,
    environment: opts.environment ?? "production",
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
  await db.insert(deploymentsTable).values({
    ...deploymentToRow(dep),
    serverId: opts.serverId ?? null,
    buildServerId: opts.buildServerId ?? null,
  });
}

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
