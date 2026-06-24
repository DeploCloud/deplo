import {
  deployments as deploymentsTable,
  projects as projectsTable,
  projectBuild as projectBuildTable,
  projectBuildMethodSettings as projectBuildMethodSettingsTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { buildConfigFor } from "../frameworks";
import {
  buildToRow,
  deploymentToRow,
  methodSettingsToRow,
  projectToRow,
} from "./project-graph-rows";
import type { TestDb } from "../db/test-harness";
import type { Deployment, Project } from "../types";
import { TEAM_A, USER_1 } from "./identity-test-helpers";

/**
 * Shared seeding for the project-graph cut-set (c) data-layer tests
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

/** Truncate every project-graph table (call in `beforeEach` before seeding). */
export const TRUNCATE_PROJECT_GRAPH = `truncate table
  team_project_order, team_folder_order,
  shared_env_group_targets, shared_env_group_projects, shared_env_group_vars, shared_env_groups,
  deployment_logs, deployments, env_var_targets, env_vars,
  domain_middlewares, domains,
  project_mounts, project_volumes, project_exposes, project_dev,
  project_build_method_settings, project_build, projects,
  folders, servers
  restart identity cascade;`;

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

export interface SeedProjectOpts {
  id: string;
  teamId?: string;
  serverId?: string;
  slug?: string;
  status?: Project["status"];
  source?: Project["source"];
}

/** Seed one project + its 1-to-1 build / method-settings rows. Returns the id. */
export async function seedProject(
  db: TestDb,
  opts: SeedProjectOpts,
): Promise<string> {
  const teamId = opts.teamId ?? TEAM_A;
  const serverId = opts.serverId ?? SERVER_1;
  const build = buildConfigFor("nextjs", {});
  const project: Project = {
    id: opts.id,
    name: opts.id,
    slug: opts.slug ?? opts.id,
    teamId,
    folderId: null,
    serverId,
    framework: "nextjs",
    logo: null,
    source: opts.source ?? "github",
    repo: { provider: "github", url: "https://x", repo: "o/r", branch: "main" },
    dockerImage: null,
    upload: null,
    compose: null,
    expose: null,
    exposes: null,
    mounts: null,
    volumes: null,
    build,
    dev: null,
    productionUrl: null,
    status: opts.status ?? "active",
    autoDeploy: true,
    latestDeploymentId: null,
    createdAt: T0,
    updatedAt: T0,
  };
  await db.insert(projectsTable).values(projectToRow(project));
  await db.insert(projectBuildTable).values(buildToRow(project.id, build));
  await db
    .insert(projectBuildMethodSettingsTable)
    .values(methodSettingsToRow(project.id, build.methodSettings));
  return project.id;
}

/** Seed a deployment row for a project. */
export async function seedDeployment(
  db: TestDb,
  opts: {
    id: string;
    projectId: string;
    status?: Deployment["status"];
    createdAt?: string;
  },
): Promise<void> {
  const dep: Deployment = {
    id: opts.id,
    projectId: opts.projectId,
    status: opts.status ?? "ready",
    environment: "production",
    commitSha: "",
    commitMessage: "deploy",
    commitAuthor: "Owner",
    branch: "main",
    url: "https://x",
    createdAt: opts.createdAt ?? T0,
    readyAt: null,
    buildDurationMs: null,
    creator: "Owner",
  };
  await db.insert(deploymentsTable).values(deploymentToRow(dep));
}

export { TEAM_A, USER_1 };
