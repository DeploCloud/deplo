// https://deplo.build/docs/guides/mcp-server

import * as z from "zod";
import type { Capability } from "../types";

/**
 * The MCP tool table. ** A secret that enters a model's context window has left
 * deplo for a third party's logs and cannot be revoked from there.
 */

export type ToolRequirement = Capability | "instanceAdmin";

export interface McpToolDef<
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
  /** Wire name. Unprefixed: clients already namespace by server ("deplo"). */
  name: string;
  /** Human label for the settings table and `tools/list`. */
  title: string;
  /** One line the model reads to decide whether this is the right tool. */
  description: string;
  group: string;
  input: S;
  /** The GraphQL document run on the caller's behalf. */
  query: string;
  /**
   * Capability the caller must hold for this tool to be listed. `null` = any
   * authenticated token. Filtering is cosmetic; the data layer is the boundary.
   */
  requires: ToolRequirement | null;
  readOnly?: boolean;
  /**
   * Destroys or replaces something. Its whole effect is `destructiveHint` in
   * `tools/list`, which is what makes an MCP client ask its own user before
   * running the tool.
   */
  destructive?: boolean;
  idempotent?: boolean;
  /** Map tool args to GraphQL variables when the shapes differ. */
  variables?: (args: z.infer<S>) => Record<string, unknown>;
  /**
   * Slice the result's single top-level array by `limit`/`offset` so a fleet of
   * 74 apps does not arrive as one wall of JSON. The tool's input schema must
   * carry `limit` and `offset` for this to be reachable.
   */
  paginate?: boolean;
  /** Runs instead of `query`. Only for the two log reads, which are not GraphQL. */
  run?: (args: z.infer<S>) => Promise<unknown>;
}

/**
 * Shorthand so every row reads as a table rather than as a type annotation, and so
 * each row's callbacks are typed by ITS OWN zod schema rather than by a
 * lowest-common-denominator record.
 */
const tool = <S extends z.ZodObject<z.ZodRawShape>>(
  t: McpToolDef<S>,
): McpToolDef => t as unknown as McpToolDef;

const page = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("How many to return (default 50)."),
  offset: z.number().int().min(0).optional().describe("How many to skip."),
};

const appId = z.string().describe("The app's id, as returned by list_apps.");
const databaseId = z
  .string()
  .describe("The database's id, as returned by list_databases.");
const serverId = z
  .string()
  .describe("The server's id, as returned by list_servers.");

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

const DIAGNOSTICS: McpToolDef[] = [
  tool({
    name: "whoami",
    title: "Who am I",
    description:
      "Which deplo team this connection acts in, and what this token is allowed to do. Run this first when something is refused.",
    group: "Diagnostics",
    requires: null,
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpWhoami {
        apiContext
        me {
          id
          username
          name
          isInstanceAdmin
        }
        viewerTeam {
          id
          name
          slug
        }
        myTeams {
          id
          name
          slug
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Apps - read
 * ------------------------------------------------------------------ */

const APP_FIELDS = /* GraphQL */ `
  id
  slug
  name
  status
  productionUrl
  serverId
  projectId
  folderId
  framework
  autoDeploy
  updatedAt
`;

const DEPLOYMENT_FIELDS = /* GraphQL */ `
  id
  appId
  status
  environment
  branch
  commitSha
  commitMessage
  creator
  createdAt
  readyAt
  buildDurationMs
  canRollback
  url
`;

const APPS_READ: McpToolDef[] = [
  tool({
    name: "list_apps",
    title: "List apps",
    description:
      "Every app in this team with its live status and URL. The starting point for almost everything.",
    group: "Apps",
    requires: "view",
    readOnly: true,
    idempotent: true,
    paginate: true,
    input: z.object({
      q: z
        .string()
        .optional()
        .describe(
          "Keep only apps whose name, slug or id contains this. Omit for all of them.",
        ),
      ...page,
    }),
    query: /* GraphQL */ `
      query McpListApps($q: String) { apps(q: $q) { ${APP_FIELDS} } }
    `,
  }),
  tool({
    name: "find",
    title: "Find an app or database in any team",
    description:
      "Search apps and databases by name, slug or id across EVERY team this " +
      "connection was granted - the only tool that is not scoped to one team. " +
      "Use it when you don't know where something lives: each hit says which " +
      "team it is in, which is the value to pass as `team` on the next call. " +
      'Case and separators are ignored, so "better auth" finds ' +
      "`better-auth-docs`. At most 50 of each kind.",
    group: "Apps",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({
      q: z.string().describe("Part of a name, slug or id."),
    }),
    query: /* GraphQL */ `
      query McpFind($q: String!) {
        search(q: $q) {
          apps {
            id
            name
            slug
            status
            productionUrl
            team {
              id
              name
              slug
            }
          }
          databases {
            id
            name
            type
            status
            team {
              id
              name
              slug
            }
          }
        }
      }
    `,
  }),
  tool({
    name: "get_app",
    title: "Get an app",
    description:
      "One app in full, by slug: build settings, source, volumes, resource limits and its latest deployment.",
    group: "Apps",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({
      slug: z.string().describe("The app's slug, as returned by list_apps."),
    }),
    query: /* GraphQL */ `
      query McpGetApp($slug: String!) {
        app(slug: $slug) {
          ${APP_FIELDS}
          dockerImage
          compose
          composeUpArgs
          rollbackKeep
          deployHookEnabled
          domainCount
          source
          resources { memoryMb cpuMilli pidsLimit storageGb }
          volumes { name type mountPath hostPath readOnly }
          latestDeployment { ${DEPLOYMENT_FIELDS} }
        }
      }
    `,
  }),
  tool({
    name: "list_deployments",
    title: "List deployments",
    description:
      "Deployment history, newest first. Filter by app, environment or status to find what failed.",
    group: "Apps",
    requires: "view",
    readOnly: true,
    idempotent: true,
    paginate: true,
    input: z.object({
      appId: appId.optional(),
      status: z
        .enum(["queued", "building", "success", "failed", "cancelled"])
        .optional(),
      ...page,
    }),
    query: /* GraphQL */ `
      query McpListDeployments($appId: String, $status: DeploymentStatus) {
        deployments(appId: $appId, status: $status) { ${DEPLOYMENT_FIELDS} }
      }
    `,
  }),
  tool({
    name: "get_deployment",
    title: "Get a deployment",
    description:
      "One deployment with its full build log. This is how you find out why a build failed.",
    group: "Apps",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({
      id: z.string().describe("The deployment's id, from list_deployments."),
    }),
    query: /* GraphQL */ `
      query McpGetDeployment($id: String!) {
        deployment(id: $id) {
          ${DEPLOYMENT_FIELDS}
          logs { ts level text }
        }
      }
    `,
  }),
  tool({
    name: "render_compose",
    title: "Render an app's compose file",
    description:
      "The exact Docker Compose deplo would ship for this app. Read-only: it renders, it does not deploy.",
    group: "Apps",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      mutation McpRenderCompose($appId: String!) {
        renderComposeStack(appId: $appId)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Apps - operate
 * ------------------------------------------------------------------ */

const APPS_OPS: McpToolDef[] = [
  tool({
    name: "deploy_app",
    title: "Deploy an app",
    description:
      "Build and deploy the app's current source. Returns the new deployment; poll get_deployment for the outcome.",
    group: "Apps",
    requires: "deploy_apps",
    input: z.object({ appId }),
    query: /* GraphQL */ `
      mutation McpRedeploy($appId: String!) {
        redeploy(appId: $appId) { ${DEPLOYMENT_FIELDS} }
      }
    `,
  }),
  tool({
    name: "rebuild_app",
    title: "Rebuild an app",
    description:
      "Rebuild the image from scratch and replace the running stack. Use when a cached layer is the problem.",
    group: "Apps",
    requires: "deploy_apps",
    destructive: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      mutation McpRebuildApp($id: String!) { rebuildApp(id: $id) { ${APP_FIELDS} } }
    `,
    variables: (a) => ({ id: a.appId }),
  }),
  tool({
    name: "rollback_deployment",
    title: "Roll back to a deployment",
    description:
      "Put the app back on a previous deployment's image. No rebuild - it re-runs what already shipped.",
    group: "Apps",
    requires: "rollback_apps",
    destructive: true,
    input: z.object({
      deploymentId: z
        .string()
        .describe("The deployment to return to (needs canRollback: true)."),
    }),
    query: /* GraphQL */ `
      mutation McpRollback($deploymentId: String!) {
        rollbackDeployment(deploymentId: $deploymentId) { ${DEPLOYMENT_FIELDS} }
      }
    `,
  }),
  tool({
    name: "cancel_deployment",
    title: "Cancel a deployment",
    description: "Stop an in-flight build or deploy.",
    group: "Apps",
    requires: "deploy_apps",
    input: z.object({ id: z.string().describe("The deployment's id.") }),
    query: /* GraphQL */ `
      mutation McpCancelDeployment($id: String!) {
        cancelDeployment(id: $id)
      }
    `,
  }),
  tool({
    name: "start_app",
    title: "Start an app",
    description: "Start a stopped app's containers.",
    group: "Apps",
    requires: "control_apps",
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      mutation McpStartApp($id: String!) { startApp(id: $id) { ${APP_FIELDS} } }
    `,
    variables: (a) => ({ id: a.appId }),
  }),
  tool({
    name: "stop_app",
    title: "Stop an app",
    description:
      "Stop the app's containers. The app stops serving traffic; nothing is deleted.",
    group: "Apps",
    requires: "control_apps",
    idempotent: true,
    destructive: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      mutation McpStopApp($id: String!) { stopApp(id: $id) { ${APP_FIELDS} } }
    `,
    variables: (a) => ({ id: a.appId }),
  }),
  tool({
    name: "reload_app",
    title: "Reload an app's routing",
    description:
      "Re-apply domains and routing without rebuilding. Use after a domain or port change.",
    group: "Apps",
    requires: "control_apps",
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      mutation McpReloadApp($id: String!) {
        reloadApp(id: $id)
      }
    `,
    variables: (a) => ({ id: a.appId }),
  }),
  tool({
    name: "bulk_app_action",
    title: "Start, stop or restart a whole folder or project",
    description:
      "Apply one action to every app in a folder or project at once.",
    group: "Apps",
    requires: "control_apps",
    destructive: true,
    input: z
      .object({
        action: z.enum(["start", "stop", "restart"]),
        folderId: z.string().optional(),
        projectId: z.string().optional(),
      })
      .describe("Give exactly one of folderId or projectId."),
    query: /* GraphQL */ `
      mutation McpBulkAppAction(
        $action: BulkAppAction!
        $folderId: ID
        $projectId: ID
      ) {
        bulkAppAction(
          action: $action
          folderId: $folderId
          projectId: $projectId
        ) {
          ok
          failed
          error
        }
      }
    `,
  }),
  tool({
    name: "bulk_redeploy_apps",
    title: "Redeploy a whole folder or project",
    description: "Redeploy every app in a folder or project.",
    group: "Apps",
    requires: "deploy_apps",
    destructive: true,
    input: z.object({
      folderId: z.string().optional(),
      projectId: z.string().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpBulkRedeploy($folderId: ID, $projectId: ID) {
        bulkRedeployApps(folderId: $folderId, projectId: $projectId) {
          ok
          failed
          error
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Apps - configure & delete
 * ------------------------------------------------------------------ */

const APPS_CONFIG: McpToolDef[] = [
  tool({
    name: "create_app",
    title: "Create an app",
    description:
      "Create an app from a git repo, a Docker image or a compose file. It is not deployed until you call deploy_app.",
    group: "Apps",
    requires: "create_apps",
    input: z.object({
      name: z.string(),
      source: z.enum(["GIT", "GITHUB", "DOCKER_IMAGE", "COMPOSE"]),
      repoUrl: z.string().optional().describe("Clone URL, for GIT/GITHUB."),
      repo: z.string().optional().describe('Owner/name, e.g. "acme/api".'),
      branch: z.string().optional().describe("Defaults to main."),
      dockerImage: z.string().optional().describe("For DOCKER_IMAGE."),
      compose: z.string().optional().describe("Compose YAML, for COMPOSE."),
      serverId: z.string().optional(),
      projectId: z.string().optional(),
      environmentId: z.string().optional(),
      folderId: z.string().optional(),
      autoDeploy: z.boolean().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpCreateApp($input: CreateAppInput!) {
        createApp(input: $input) { ${APP_FIELDS} }
      }
    `,
    variables: (a) => ({
      input: {
        name: a.name,
        source: a.source,
        dockerImage: a.dockerImage,
        compose: a.compose,
        serverId: a.serverId,
        projectId: a.projectId,
        environmentId: a.environmentId,
        folderId: a.folderId,
        autoDeploy: a.autoDeploy,
        repo: a.repoUrl
          ? {
              url: a.repoUrl,
              repo: a.repo ?? "",
              branch: a.branch ?? "main",
              provider: a.source === "GITHUB" ? "github" : "git",
            }
          : undefined,
      },
    }),
  }),
  tool({
    name: "rename_app",
    title: "Rename an app",
    description: "Change an app's display name. The slug and URLs do not move.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({ appId, name: z.string() }),
    query: /* GraphQL */ `
      mutation McpRenameApp($id: String!, $name: String!) {
        renameApp(id: $id, name: $name) { ${APP_FIELDS} }
      }
    `,
    variables: (a) => ({ id: a.appId, name: a.name }),
  }),
  tool({
    name: "update_app_build",
    title: "Change build settings",
    description:
      "Set the build method, commands, root directory, runtime version or exposed port. Takes effect on the next deploy.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({
      appId,
      buildMethod: z
        .string()
        .optional()
        .describe("e.g. nixpacks, railpack, dockerfile."),
      buildCommand: z.string().optional(),
      installCommand: z.string().optional(),
      startCommand: z.string().optional(),
      rootDir: z.string().optional(),
      outputDir: z.string().optional(),
      runtimeVersion: z.string().optional(),
      port: z.number().int().optional(),
      buildCache: z.boolean().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpUpdateAppBuild($id: String!, $build: BuildConfigInput!) {
        updateAppBuild(id: $id, build: $build) { ${APP_FIELDS} }
      }
    `,
    variables: ({ appId: id, ...build }) => ({ id, build }),
  }),
  tool({
    name: "update_app_source",
    title: "Change where an app deploys from",
    description:
      "Point the app at a different repo, branch, image or compose file, or move it to another server.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({
      appId,
      source: z.enum(["GIT", "GITHUB", "DOCKER_IMAGE", "COMPOSE"]),
      repoUrl: z.string().optional(),
      repo: z.string().optional(),
      branch: z.string().optional(),
      dockerImage: z.string().optional(),
      compose: z.string().optional(),
      serverId: z.string().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpUpdateAppSource($id: String!, $input: UpdateSourceInput!) {
        updateAppSource(id: $id, input: $input) { ${APP_FIELDS} }
      }
    `,
    variables: (a) => ({
      id: a.appId,
      input: {
        source: a.source,
        dockerImage: a.dockerImage,
        compose: a.compose,
        serverId: a.serverId,
        repo: a.repoUrl
          ? {
              url: a.repoUrl,
              repo: a.repo ?? "",
              branch: a.branch ?? "main",
              provider: a.source === "GITHUB" ? "github" : "git",
            }
          : undefined,
      },
    }),
  }),
  tool({
    name: "set_app_resources",
    title: "Set an app's resource limits",
    description:
      "Cap the app's memory, CPU, PIDs or disk. Applied on the next deploy.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({
      appId,
      memoryMb: z.number().int().optional(),
      cpuMilli: z.number().int().optional(),
      pidsLimit: z.number().int().optional(),
      storageGb: z.number().int().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpSetAppResources($id: String!, $limits: ResourceLimitsInput!) {
        updateAppResources(id: $id, limits: $limits) { ${APP_FIELDS} }
      }
    `,
    variables: ({ appId: id, ...limits }) => ({ id, limits }),
  }),
  tool({
    name: "set_app_auto_deploy",
    title: "Turn auto-deploy on or off",
    description: "Whether a push to the tracked branch deploys automatically.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({ appId, enabled: z.boolean() }),
    query: /* GraphQL */ `
      mutation McpSetAutoDeploy($id: String!, $value: Boolean!) {
        setAppAutoDeploy(id: $id, value: $value) { ${APP_FIELDS} }
      }
    `,
    variables: (a) => ({ id: a.appId, value: a.enabled }),
  }),
  tool({
    name: "clear_app_build_cache",
    title: "Clear an app's build cache",
    description:
      "Throw away cached build layers so the next deploy starts clean.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      mutation McpClearBuildCache($id: String!) { clearAppBuildCache(id: $id) { ${APP_FIELDS} } }
    `,
    variables: (a) => ({ id: a.appId }),
  }),
  tool({
    name: "delete_app",
    title: "Delete an app",
    description:
      "Permanently delete an app, its containers and its volumes. There is no undo.",
    group: "Apps",
    requires: "delete_apps",
    destructive: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      mutation McpDeleteApp($id: String!) {
        deleteApp(id: $id)
      }
    `,
    variables: (a) => ({ id: a.appId }),
  }),
];

/* ------------------------------------------------------------------ *
 * Environment variables - masked reads only
 * ------------------------------------------------------------------ */

const ENV: McpToolDef[] = [
  tool({
    name: "list_env",
    title: "List environment variables",
    description:
      "An app's variables. Secret values are masked and there is no way to reveal them over MCP - read the key names, not the values.",
    group: "Environment",
    // `manage_env`, not `view`: `listEnv` answers an empty list to anyone without it
    // rather than throwing, so listing this tool for a `view`-only token would hand the
    // model a silent lie ("this app has no variables") instead of a refusal it can
    requires: "manage_env",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      query McpListEnv($appId: String!) {
        env(appId: $appId) {
          id
          key
          value
          type
          isMasked
          targets
          updatedAt
        }
      }
    `,
  }),
  tool({
    name: "set_env_var",
    title: "Set an environment variable",
    description:
      "Create one variable, or update a plain one. Mark it secret unless it is genuinely public - a secret can never be edited afterwards, only deleted. Takes effect on the next deploy.",
    group: "Environment",
    requires: "manage_env",
    idempotent: true,
    input: z.object({
      appId,
      key: z.string(),
      value: z.string(),
      secret: z
        .boolean()
        .optional()
        .describe(
          "Store masked (default true). Only set false for public values.",
        ),
    }),
    query: /* GraphQL */ `
      mutation McpUpsertEnv($input: UpsertEnvInput!) {
        upsertEnv(input: $input) {
          id
          key
          type
          isMasked
        }
      }
    `,
    variables: (a) => ({
      input: {
        appId: a.appId,
        key: a.key,
        value: a.value,
        type: a.secret === false ? "plain" : "secret",
      },
    }),
  }),
  tool({
    name: "delete_env_var",
    title: "Delete an environment variable",
    description: "Remove one variable. Takes effect on the next deploy.",
    group: "Environment",
    requires: "manage_env",
    destructive: true,
    input: z.object({
      id: z.string().describe("The variable's id, from list_env."),
    }),
    query: /* GraphQL */ `
      mutation McpDeleteEnv($id: String!) {
        deleteEnv(id: $id)
      }
    `,
  }),
  tool({
    name: "import_env",
    title: "Import a .env file",
    description:
      "Bulk-add variables from .env text. Every line lands as plain, so a key that already exists as a secret is skipped and counted, never overwritten.",
    group: "Environment",
    requires: "manage_env",
    input: z.object({
      appId,
      blob: z.string().describe("The .env file's contents."),
    }),
    query: /* GraphQL */ `
      mutation McpImportEnv($appId: String!, $blob: String!) {
        importEnv(appId: $appId, blob: $blob) {
          added
          skippedSecrets
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Domains
 * ------------------------------------------------------------------ */

const DOMAIN_FIELDS = /* GraphQL */ `
  id
  appId
  name
  primary
  status
  ssl
  certProvider
  port
  entrypoint
  proxied
`;

const DOMAINS: McpToolDef[] = [
  tool({
    name: "list_domains",
    title: "List domains",
    description:
      "Domains for one app, or every domain in the team. Shows DNS/certificate status.",
    group: "Domains",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId: appId.optional() }),
    query: /* GraphQL */ `
      query McpListDomains($appId: String) { domains(appId: $appId) { ${DOMAIN_FIELDS} } }
    `,
  }),
  tool({
    name: "add_domain",
    title: "Add a domain",
    description:
      "Point a hostname at an app. Certificates stay off unless you ask for letsencrypt.",
    group: "Domains",
    requires: "manage_domains",
    input: z.object({
      appId,
      name: z.string().describe("The hostname, e.g. api.acme.com."),
      port: z.number().int().optional().describe("Container port to route to."),
      certProvider: z.enum(["none", "letsencrypt", "custom"]).optional(),
    }),
    query: /* GraphQL */ `
      mutation McpAddDomain($appId: String!, $name: String!, $config: DomainConfigInput) {
        addDomain(appId: $appId, name: $name, config: $config) { ${DOMAIN_FIELDS} }
      }
    `,
    variables: (a) => ({
      appId: a.appId,
      name: a.name,
      config:
        a.port || a.certProvider
          ? { port: a.port, certProvider: a.certProvider }
          : undefined,
    }),
  }),
  tool({
    name: "verify_domain",
    title: "Verify a domain",
    description:
      "Re-check DNS and issue or renew the certificate. Run this after changing a DNS record.",
    group: "Domains",
    requires: "manage_domains",
    idempotent: true,
    input: z.object({ id: z.string().describe("The domain's id.") }),
    query: /* GraphQL */ `
      mutation McpVerifyDomain($id: String!) { verifyDomain(id: $id) { ${DOMAIN_FIELDS} } }
    `,
  }),
  tool({
    name: "set_primary_domain",
    title: "Make a domain primary",
    description:
      "Choose the canonical hostname; the app's URL follows it everywhere in deplo.",
    group: "Domains",
    requires: "manage_domains",
    idempotent: true,
    input: z.object({ id: z.string().describe("The domain's id.") }),
    query: /* GraphQL */ `
      mutation McpSetPrimaryDomain($id: String!) {
        setPrimaryDomain(id: $id)
      }
    `,
  }),
  tool({
    name: "remove_domain",
    title: "Remove a domain",
    description: "Stop routing a hostname to the app.",
    group: "Domains",
    requires: "manage_domains",
    destructive: true,
    input: z.object({ id: z.string().describe("The domain's id.") }),
    query: /* GraphQL */ `
      mutation McpRemoveDomain($id: String!) {
        removeDomain(id: $id)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Databases
 * ------------------------------------------------------------------ */

const DATABASE_FIELDS = /* GraphQL */ `
  id
  name
  type
  version
  status
  host
  port
  dbName
  username
  serverId
  sizeMb
  exposedPublicly
  connectionStringMasked
`;

const DATABASES: McpToolDef[] = [
  tool({
    name: "list_databases",
    title: "List databases",
    description:
      "Every managed database in this team, with status and size. Connection strings are masked.",
    group: "Databases",
    requires: "view",
    readOnly: true,
    idempotent: true,
    paginate: true,
    input: z.object({
      q: z
        .string()
        .optional()
        .describe(
          "Keep only databases whose name or id contains this. Omit for all of them.",
        ),
      ...page,
    }),
    query: /* GraphQL */ `
      query McpListDatabases($q: String) { databases(q: $q) { ${DATABASE_FIELDS} } }
    `,
  }),
  tool({
    name: "get_database",
    title: "Get a database",
    description: "One database in full, including its resource limits.",
    group: "Databases",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({ id: databaseId }),
    query: /* GraphQL */ `
      query McpGetDatabase($id: String!) {
        database(id: $id) {
          ${DATABASE_FIELDS}
          customImage
          customCommand
          resources { memoryMb cpuMilli pidsLimit storageGb }
        }
      }
    `,
  }),
  tool({
    name: "create_database",
    title: "Create a database",
    description:
      "Provision a managed Postgres, MySQL, MariaDB, MongoDB, Redis or ClickHouse.",
    group: "Databases",
    requires: "create_databases",
    input: z.object({
      name: z.string(),
      type: z.enum([
        "postgres",
        "mysql",
        "mariadb",
        "mongodb",
        "redis",
        "clickhouse",
      ]),
      version: z.string().describe('Engine version, e.g. "17".'),
      serverId: z.string().optional(),
      dbName: z.string().optional(),
      username: z.string().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpCreateDatabase($input: CreateDatabaseInput!) {
        createDatabase(input: $input) { ${DATABASE_FIELDS} }
      }
    `,
    variables: (a) => ({ input: a }),
  }),
  tool({
    name: "set_database_running",
    title: "Start or stop a database",
    description: "Start or stop the database container. Data is untouched.",
    group: "Databases",
    requires: "control_databases",
    idempotent: true,
    input: z.object({ id: databaseId, running: z.boolean() }),
    query: /* GraphQL */ `
      mutation McpSetDatabaseRunning($id: String!, $running: Boolean!) {
        setDatabaseRunning(id: $id, running: $running) { ${DATABASE_FIELDS} }
      }
    `,
  }),
  tool({
    name: "restart_database",
    title: "Restart a database",
    description: "Restart the container. Data is untouched.",
    group: "Databases",
    requires: "control_databases",
    idempotent: true,
    input: z.object({ id: databaseId }),
    query: /* GraphQL */ `
      mutation McpRestartDatabase($id: String!) { restartDatabase(id: $id) { ${DATABASE_FIELDS} } }
    `,
  }),
  tool({
    name: "rebuild_database",
    title: "Rebuild a database (factory reset)",
    description:
      "WIPES the data volume and provisions the database again from scratch. Use redeploy or restart to preserve data.",
    group: "Databases",
    requires: "delete_databases",
    destructive: true,
    input: z.object({ id: databaseId }),
    query: /* GraphQL */ `
      mutation McpRebuildDatabase($id: String!) { rebuildDatabase(id: $id) { ${DATABASE_FIELDS} } }
    `,
  }),
  tool({
    name: "delete_database",
    title: "Delete a database",
    description:
      "Permanently delete the database, its container and its volume. Refuses unless the host confirms both are gone.",
    group: "Databases",
    requires: "delete_databases",
    destructive: true,
    input: z.object({ id: databaseId }),
    query: /* GraphQL */ `
      mutation McpDeleteDatabase($id: String!) {
        deleteDatabase(id: $id)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Logs, not GraphQL: see lib/data/logs-snapshot.ts
 * ------------------------------------------------------------------ */

const LOGS: McpToolDef[] = [
  tool({
    name: "app_logs",
    title: "Read an app's logs",
    description:
      "The tail of an app container's runtime output. Truncated to keep it readable; ask for fewer lines if you only need the end.",
    group: "Logs",
    requires: "view_logs",
    readOnly: true,
    idempotent: true,
    input: z.object({
      appId,
      lines: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("How many lines back (default 200)."),
      container: z
        .string()
        .optional()
        .describe("A specific container; defaults to the app's own."),
    }),
    query: "",
    run: async (a) => {
      const { appLogsSnapshot } = await import("../data/logs-snapshot");
      return appLogsSnapshot(a.appId, {
        lines: a.lines,
        container: a.container,
      });
    },
  }),
  tool({
    name: "database_logs",
    title: "Read a database's logs",
    description: "The tail of a database container's output.",
    group: "Logs",
    requires: "view_logs",
    readOnly: true,
    idempotent: true,
    input: z.object({
      databaseId,
      lines: z.number().int().min(1).max(500).optional(),
      container: z.string().optional(),
    }),
    query: "",
    run: async (a) => {
      const { databaseLogsSnapshot } = await import("../data/logs-snapshot");
      return databaseLogsSnapshot(a.databaseId, {
        lines: a.lines,
        container: a.container,
      });
    },
  }),
];

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

const METRICS: McpToolDef[] = [
  tool({
    name: "server_metrics",
    title: "Server metrics",
    description:
      "Live CPU, memory and disk for one server. This is how you explain a build that failed on a full disk.",
    group: "Monitoring",
    requires: "view_metrics",
    readOnly: true,
    idempotent: true,
    input: z.object({ serverId }),
    query: /* GraphQL */ `
      query McpServerMetrics($serverId: String!) {
        serverMetrics(serverId: $serverId) {
          serverId
          online
          cpu
          cpuCores
          memUsed
          memTotal
          memPct
          diskUsed
          diskTotal
          diskPct
          load
          containers
          uptimeSec
          ts
        }
      }
    `,
  }),
  tool({
    name: "app_metrics",
    title: "App metrics",
    description: "Live CPU, memory and I/O for an app's containers.",
    group: "Monitoring",
    requires: "view_metrics",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      query McpAppMetrics($appId: String!) {
        appMetrics(appId: $appId) {
          id
          online
          cpu
          memUsed
          memLimit
          memPct
          netRx
          netTx
          blockRead
          blockWrite
          pids
          containers
          running
          ts
        }
      }
    `,
  }),
  tool({
    name: "database_metrics",
    title: "Database metrics",
    description: "Live CPU, memory and I/O for a database container.",
    group: "Monitoring",
    requires: "view_metrics",
    readOnly: true,
    idempotent: true,
    input: z.object({ databaseId }),
    query: /* GraphQL */ `
      query McpDatabaseMetrics($databaseId: String!) {
        databaseMetrics(databaseId: $databaseId) {
          id
          online
          cpu
          memUsed
          memLimit
          memPct
          netRx
          netTx
          pids
          running
          ts
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Backups
 * ------------------------------------------------------------------ */

const BACKUPS: McpToolDef[] = [
  tool({
    name: "list_backups",
    title: "List backup schedules",
    description: "Every backup schedule in the team, with its last result.",
    group: "Backups",
    requires: "view",
    readOnly: true,
    idempotent: true,
    paginate: true,
    input: z.object({ ...page }),
    query: /* GraphQL */ `
      query McpListBackups {
        backups {
          id
          name
          targetKind
          appId
          databaseId
          destinationId
          destinationName
          schedule
          timezone
          enabled
          retentionCount
          lastRunAt
          lastStatus
        }
      }
    `,
  }),
  tool({
    name: "list_backup_runs",
    title: "List backup runs",
    description: "Backup history for one app or database, newest first.",
    group: "Backups",
    requires: "view",
    readOnly: true,
    idempotent: true,
    paginate: true,
    input: z.object({
      appId: appId.optional(),
      databaseId: databaseId.optional(),
      ...page,
    }),
    query: /* GraphQL */ `
      query McpListBackupRuns($appId: String, $databaseId: String) {
        backupRuns(appId: $appId, databaseId: $databaseId) {
          id
          backupId
          status
          startedAt
          finishedAt
          sizeBytes
          verified
          error
        }
      }
    `,
  }),
  tool({
    name: "run_app_backup",
    title: "Back up an app now",
    description: "Take an immediate backup of an app to a destination.",
    group: "Backups",
    requires: "manage_backups",
    input: z.object({
      appId,
      destinationId: z
        .string()
        .describe("Where to store it, from list_destinations."),
    }),
    query: /* GraphQL */ `
      mutation McpRunAppBackup($appId: String!, $destinationId: String!) {
        runAppBackup(appId: $appId, destinationId: $destinationId)
      }
    `,
  }),
  tool({
    name: "run_database_backup",
    title: "Back up a database now",
    description: "Take an immediate backup of a database to a destination.",
    group: "Backups",
    requires: "manage_backups",
    input: z.object({ databaseId, destinationId: z.string() }),
    query: /* GraphQL */ `
      mutation McpRunDatabaseBackup(
        $databaseId: String!
        $destinationId: String!
      ) {
        runDatabaseBackup(
          databaseId: $databaseId
          destinationId: $destinationId
        )
      }
    `,
  }),
  tool({
    name: "restore_backup",
    title: "Restore a backup",
    description:
      "Restore an artifact in place. This OVERWRITES the live app or database with the backup's contents.",
    group: "Backups",
    requires: "restore_backups",
    destructive: true,
    input: z.object({
      runId: z.string().describe("The backup run's id, from list_backup_runs."),
    }),
    query: /* GraphQL */ `
      mutation McpRestoreBackup($runId: String!) {
        restoreBackup(runId: $runId)
      }
    `,
  }),
  tool({
    name: "list_destinations",
    title: "List backup destinations",
    description: "Where backups can be stored: a bucket or a server's disk.",
    group: "Backups",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListDestinations {
        backupDestinations {
          id
          name
          kind
          where
          status
          bucket
          endpoint
          region
          path
          serverId
          serverName
          encrypted
          freeBytes
          totalBytes
          lastTestAt
          lastTestError
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Cron
 * ------------------------------------------------------------------ */

const CRON_FIELDS = /* GraphQL */ `
  id
  name
  description
  command
  schedule
  timezone
  enabled
  service
  lastRunAt
  lastStatus
  nextRunAt
`;

const CRON: McpToolDef[] = [
  tool({
    name: "list_cron_jobs",
    title: "List cron jobs",
    description: "Scheduled commands for one app or database.",
    group: "Cron",
    requires: "manage_crons",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      query McpListCronJobs($appId: ID!) {
        appCronJobs(appId: $appId) { enabled targetId services jobs { ${CRON_FIELDS} } }
      }
    `,
  }),
  tool({
    name: "create_cron_job",
    title: "Create a cron job",
    description:
      "Schedule a command inside an app's container. The schedule is standard cron syntax.",
    group: "Cron",
    requires: "manage_crons",
    input: z.object({
      appId,
      name: z.string(),
      command: z.string(),
      schedule: z.string().describe('Cron syntax, e.g. "0 3 * * *".'),
      timezone: z.string().optional().describe("IANA zone, e.g. Europe/Rome."),
      description: z.string().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpCreateCronJob($targetId: ID!, $targetKind: String!, $input: CronJobInput!) {
        createCronJob(targetId: $targetId, targetKind: $targetKind, input: $input) { ${CRON_FIELDS} }
      }
    `,
    variables: (a) => ({
      targetId: a.appId,
      targetKind: "app",
      input: {
        name: a.name,
        command: a.command,
        schedule: a.schedule,
        timezone: a.timezone,
        description: a.description,
        enabled: true,
      },
    }),
  }),
  tool({
    name: "run_cron_job_now",
    title: "Run a cron job now",
    description: "Fire a scheduled job immediately, off its schedule.",
    group: "Cron",
    requires: "manage_crons",
    input: z.object({ id: z.string().describe("The job's id.") }),
    query: /* GraphQL */ `
      mutation McpRunCronNow($id: ID!) {
        runCronJobNow(id: $id) {
          id
          status
          startedAt
          finishedAt
          exitCode
        }
      }
    `,
  }),
  tool({
    name: "delete_cron_job",
    title: "Delete a cron job",
    description: "Delete a scheduled job and its run history.",
    group: "Cron",
    requires: "manage_crons",
    destructive: true,
    input: z.object({ id: z.string() }),
    query: /* GraphQL */ `
      mutation McpDeleteCronJob($id: ID!) {
        deleteCronJob(id: $id)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Pull-request previews
 * ------------------------------------------------------------------ */

const PREVIEWS: McpToolDef[] = [
  tool({
    name: "list_previews",
    title: "List pull-request previews",
    description:
      "Preview stacks for an app's open pull requests, and why previews may not be working.",
    group: "Previews",
    requires: "manage_previews",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      query McpListPreviews($appId: ID!) {
        appPreviews(appId: $appId) {
          enabled
          autoDeploy
          maxActive
          unavailable
          previews {
            id
            prNumber
            title
            author
            headBranch
            status
            url
            closed
            approved
          }
        }
      }
    `,
  }),
  tool({
    name: "deploy_pull_request",
    title: "Deploy a pull request preview",
    description: "Build a preview stack for one open pull request.",
    group: "Previews",
    requires: "manage_previews",
    input: z.object({ appId, prNumber: z.number().int() }),
    query: /* GraphQL */ `
      mutation McpDeployPr($appId: ID!, $prNumber: Int!) {
        deployPullRequest(appId: $appId, prNumber: $prNumber) {
          id
          prNumber
          status
          url
        }
      }
    `,
  }),
  tool({
    name: "destroy_preview",
    title: "Destroy a preview",
    description: "Stop and remove a preview's containers and volumes.",
    group: "Previews",
    requires: "manage_previews",
    destructive: true,
    input: z.object({ id: z.string().describe("The preview's id.") }),
    query: /* GraphQL */ `
      mutation McpDestroyPreview($id: ID!) {
        destroyPreview(id: $id)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Organisation
 * ------------------------------------------------------------------ */

const ORGANIZATION: McpToolDef[] = [
  tool({
    name: "list_projects",
    title: "List projects",
    description:
      "Projects in this team. A project groups apps and owns their environments.",
    group: "Organization",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListProjects {
        projects {
          id
          slug
          name
          appCount
          environmentCount
          folderCount
        }
      }
    `,
  }),
  tool({
    name: "list_folders",
    title: "List folders",
    description: "Folders in this team, with how many apps each holds.",
    group: "Organization",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListFolders {
        folders {
          id
          name
          parentId
          appCount
          subfolderCount
          color
        }
      }
    `,
  }),
  tool({
    name: "list_environments",
    title: "List a project's environments",
    description:
      "Environments inside a project, with the git branch each tracks.",
    group: "Organization",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({ projectId: z.string() }),
    query: /* GraphQL */ `
      query McpListEnvironments($projectId: ID!) {
        environments(projectId: $projectId) {
          id
          slug
          name
          gitBranch
          isDefault
          kind
        }
      }
    `,
  }),
  tool({
    name: "create_folder",
    title: "Create a folder",
    description:
      "Create a folder to group apps. Folders are private to their owner until someone is granted access.",
    group: "Organization",
    requires: "create_folders",
    input: z.object({
      name: z.string(),
      parentId: z.string().optional(),
      color: z.string().optional().describe("Hex accent colour."),
    }),
    query: /* GraphQL */ `
      mutation McpCreateFolder($name: String!, $parentId: ID, $color: String) {
        createFolder(name: $name, parentId: $parentId, color: $color) {
          id
          name
          parentId
        }
      }
    `,
  }),
  tool({
    name: "move_app_to_folder",
    title: "Move an app into a folder",
    description:
      "Move an app into a folder, or to the top level with no folderId. Within " +
      "one team - to move it to a DIFFERENT team use transfer_app_to_team.",
    group: "Organization",
    requires: "move_apps",
    idempotent: true,
    input: z.object({ appId, folderId: z.string().optional() }),
    query: /* GraphQL */ `
      mutation McpMoveAppToFolder($appId: ID!, $folderId: ID) {
        moveAppToFolder(appId: $appId, folderId: $folderId)
      }
    `,
  }),
  tool({
    name: "transfer_app_to_team",
    title: "Move an app to another team",
    description:
      "Move an app, with everything it owns, to another team this connection " +
      "was granted. Needs to manage apps AND environment variables on both " +
      "sides - the app carries its encrypted variables across, so anyone moving " +
      "it has to be allowed to read them where it lands. Use `team` to say which " +
      "team the app is in now, and teamId for where it goes.",
    group: "Organization",
    requires: "move_apps",
    // Crosses a tenancy boundary and takes the app's variables with it. Not
    // reversible by re-running the tool: the destination has to send it back.
    destructive: true,
    input: z.object({ appId, teamId: z.string() }),
    query: /* GraphQL */ `
      mutation McpTransferAppToTeam($appId: String!, $teamId: String!) {
        transferAppToTeam(appId: $appId, teamId: $teamId)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Team
 * ------------------------------------------------------------------ */

const TEAM: McpToolDef[] = [
  tool({
    name: "list_members",
    title: "List team members",
    description: "Who is in this team and what each of them may do.",
    group: "Team",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListMembers {
        members {
          userId
          username
          name
          role
          roleName
          isInstanceAdmin
          capabilities
        }
      }
    `,
  }),
  tool({
    name: "list_activity",
    title: "Read the activity trail",
    description:
      "What happened in this team and who did it, newest first. Use it to explain a change nobody remembers making.",
    group: "Team",
    requires: "view_activity",
    readOnly: true,
    idempotent: true,
    input: z.object({
      limit: z.number().int().min(1).max(200).optional(),
    }),
    query: /* GraphQL */ `
      query McpActivity($limit: Int) {
        activity(limit: $limit) {
          id
          type
          message
          actor
          appId
          createdAt
        }
      }
    `,
  }),
  tool({
    name: "list_teams",
    title: "List reachable teams",
    description:
      "Teams this connection may work in. Pass `team` on any tool to work in one " +
      "of them; without it, tools use the first. A team that is not on this list " +
      "was not granted and is refused - it is granted when the connection is " +
      "approved, not from a setting anywhere.",
    group: "Team",
    requires: null,
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListTeams {
        myTeams {
          id
          name
          slug
          memberCount
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

const FILES: McpToolDef[] = [
  tool({
    name: "list_app_files",
    title: "List an app's files",
    description: "Directory listing inside an app's persistent files.",
    group: "Files",
    requires: "read_app_files",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId, path: z.string().optional() }),
    query: /* GraphQL */ `
      query McpListAppFiles($appId: String!, $path: String) {
        appFiles(appId: $appId, path: $path) {
          name
          path
          kind
          size
          modifiedAt
        }
      }
    `,
  }),
  tool({
    name: "read_app_file",
    title: "Read an app file",
    description: "Read a text file from an app's persistent files.",
    group: "Files",
    requires: "read_app_files",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId, path: z.string() }),
    query: /* GraphQL */ `
      query McpReadAppFile($appId: String!, $path: String!) {
        appFile(appId: $appId, path: $path) {
          path
          text
          size
          reason
        }
      }
    `,
  }),
  tool({
    name: "write_app_file",
    title: "Write an app file",
    description:
      "Create or overwrite a text file in an app's persistent files.",
    group: "Files",
    requires: "write_app_files",
    destructive: true,
    input: z.object({ appId, path: z.string(), content: z.string() }),
    query: /* GraphQL */ `
      mutation McpWriteAppFile(
        $appId: String!
        $path: String!
        $content: String!
      ) {
        writeAppFile(appId: $appId, path: $path, content: $content) {
          path
          size
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Servers - read for everyone, writes for instance admins
 * ------------------------------------------------------------------ */

const SERVER_FIELDS = /* GraphQL */ `
  id
  name
  host
  ip
  status
  statusMessage
  role
  agentVersion
  expectedAgentVersion
  cpuCores
  memoryMb
  diskGb
  isDeploHost
  provisioned
  lastSeenAt
`;

const SERVERS: McpToolDef[] = [
  tool({
    name: "list_servers",
    title: "List servers",
    description:
      "Every server in the fleet with its agent version and last-seen time.",
    group: "Servers",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListServers { servers { ${SERVER_FIELDS} } }
    `,
  }),
  tool({
    name: "get_server",
    title: "Get a server",
    description: "One server in full, including which teams may deploy to it.",
    group: "Servers",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      query McpGetServer($id: String!) {
        server(id: $id) {
          ${SERVER_FIELDS}
          dockerVersion hostArch deployConcurrency traefikEnabled allTeams
          teams { id name slug }
        }
      }
    `,
  }),
  tool({
    name: "check_server_health",
    title: "Check a server's health",
    description: "Probe the server's agent right now and record the result.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      mutation McpCheckServerHealth($id: String!) {
        checkServerHealth(id: $id, force: true) { ${SERVER_FIELDS} }
      }
    `,
  }),
  tool({
    name: "check_server_readiness",
    title: "Check whether a server can deploy",
    description:
      "A per-check report on whether this server can run a deployment right now: Docker, Traefik, ports, disk, build tools.",
    group: "Servers",
    requires: "instanceAdmin",
    readOnly: true,
    idempotent: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      mutation McpCheckServerReadiness($id: String!) {
        checkServerReadiness(id: $id) {
          serverId
          serverName
          verdict
          summary
          checkedAt
          checks {
            id
            label
            group
            severity
            detail
            hint
          }
        }
      }
    `,
  }),
  tool({
    name: "update_server_agent",
    title: "Update a server's agent",
    description:
      "Update the deplo agent binary on one host in place. Agent releases are forward-only: this cannot be undone.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      mutation McpUpdateServerAgent($id: String!) {
        updateServerAgent(id: $id)
      }
    `,
  }),
  tool({
    name: "restart_server_workloads",
    title: "Restart everything on a server",
    description:
      "Restart every app and database running on one host. Every workload on it stops serving briefly.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      mutation McpRestartServerWorkloads($id: String!) {
        restartServerWorkloads(id: $id) {
          restarted
          skipped
          failures {
            kind
            name
            error
          }
        }
      }
    `,
  }),
  tool({
    name: "restart_server_traefik",
    title: "Restart a server's proxy",
    description:
      "Restart Traefik on one host. Every domain it serves is briefly unreachable.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      mutation McpRestartServerTraefik($id: String!) {
        restartServerTraefik(id: $id)
      }
    `,
  }),
  tool({
    name: "run_docker_cleanup",
    title: "Reclaim disk on a server",
    description:
      "Run the Docker cleanup sweep on one host now. Never prunes volumes or system-wide.",
    group: "Servers",
    requires: "instanceAdmin",
    input: z.object({ serverId }),
    query: /* GraphQL */ `
      mutation McpRunDockerCleanup($serverId: String!) {
        runDockerCleanupNow(serverId: $serverId) {
          id
          serverId
          status
          startedAt
          finishedAt
          reclaimedBytes
          error
        }
      }
    `,
  }),
];

/**
 * Every tool, in the order the settings page groups them. The env layers have no
 * reveal left to withhold - a secret variable has no read-back path at all.
 */
export const MCP_TOOLS: McpToolDef[] = [
  ...DIAGNOSTICS,
  ...APPS_READ,
  ...APPS_OPS,
  ...APPS_CONFIG,
  ...ENV,
  ...DOMAINS,
  ...DATABASES,
  ...LOGS,
  ...METRICS,
  ...BACKUPS,
  ...CRON,
  ...PREVIEWS,
  ...ORGANIZATION,
  ...TEAM,
  ...FILES,
  ...SERVERS,
];

/** Group order for the settings table, derived so the two cannot drift. */
export const MCP_TOOL_GROUPS: string[] = [
  ...new Set(MCP_TOOLS.map((t) => t.group)),
];
