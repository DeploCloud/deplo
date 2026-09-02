// https://deplo.build/docs/guides/mcp-server

import * as z from "zod";
import type { Capability } from "../types";
import type { GraphQLContext } from "../graphql/context";

/**
 * The MCP tool table. ** A secret that enters a model's context window has left
 * Deplo for a third party's logs and cannot be revoked from there.
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
  /**
   * Runs instead of `query`, for the log reads (not GraphQL) and the two
   * passthrough tools (whose document is written by the caller, not by us).
   */
  run?: (args: z.infer<S>, ctx: GraphQLContext) => Promise<unknown>;
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
const CRON_KIND = z
  .enum(["app", "database"])
  .optional()
  .describe("What the id names. Defaults to app.");

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
      "Which Deplo team this connection acts in, and what this token is allowed to do. Run this first when something is refused.",
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
    name: "list_templates",
    title: "List templates",
    description:
      "List compact deployable variants from the public template catalog. Each row identifies the family with templateSlug and the selectable variant with variantSlug.",
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
          "Keep variants whose template, variant, category or description matches.",
        ),
      category: z.string().optional().describe("Filter by category slug."),
      ...page,
    }),
    query: /* GraphQL */ `
      query McpListTemplates($q: String, $category: String) {
        templateVariants(q: $q, category: $category) {
          templateSlug
          variantSlug
          name
          variantName
          category
          shortDescription
          docsUrl
        }
      }
    `,
  }),
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
      "Find apps and databases by name, slug or id across every team this " +
      "connection was granted - the one tool not scoped to a single team. Each " +
      "hit names its team. Case and separators are ignored. 50 of each at most.",
    group: "Apps",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({
      q: z.string().describe("Part of a name, slug or id."),
    }),
    query: /* GraphQL */ `
      query McpFind($q: String!) {
        search(q: $q, kinds: [app, database]) {
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
      "The exact Docker Compose Deplo would ship for this app. Read-only: it renders, it does not deploy.",
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
    name: "control_app",
    title: "Start or reload an app",
    description:
      "Start a stopped app, or re-apply its domains and routing without rebuilding. Reload is what you want after a domain or port change. To stop one, use stop_app.",
    group: "Apps",
    requires: "control_apps",
    idempotent: true,
    input: z.object({
      appId,
      action: z
        .enum(["start", "reload"])
        .describe("start brings the containers up; reload re-applies routing."),
    }),
    variables: (a) => ({
      id: a.appId,
      isStart: a.action === "start",
      isReload: a.action === "reload",
    }),
    query: /* GraphQL */ `
      mutation McpControlApp(
        $id: String!
        $isStart: Boolean!
        $isReload: Boolean!
      ) {
        startApp(id: $id) @include(if: $isStart) { ${APP_FIELDS} }
        reloadApp(id: $id) @include(if: $isReload)
      }
    `,
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
    name: "create_app_from_template",
    title: "Create an app from a template",
    description:
      "Create an idle App from a public catalog template. Set deploy=true to request its first deployment. Generated credentials are stored in the App Variables and are never returned by this tool.",
    group: "Apps",
    requires: "create_apps",
    input: z.object({
      templateSlug: z
        .string()
        .describe("The templateSlug from list_templates."),
      variantSlug: z
        .string()
        .optional()
        .describe('The variantSlug. Omit to use the "default" variant.'),
      name: z
        .string()
        .optional()
        .describe("The new App name. Omit to use the template name."),
      serverId: z.string().optional(),
      projectId: z.string().optional(),
      environmentId: z.string().optional(),
      folderId: z.string().optional(),
      deploy: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Request the first deployment. Defaults to false; a token also needs deploy_apps.",
        ),
    }),
    query: /* GraphQL */ `
      mutation McpCreateAppFromTemplate($input: CreateAppFromTemplateInput!) {
        createAppFromTemplate(input: $input) { ${APP_FIELDS} }
      }
    `,
    variables: (a) => ({
      input: {
        templateSlug: a.templateSlug,
        variantSlug: a.variantSlug,
        name: a.name,
        serverId: a.serverId,
        projectId: a.projectId,
        environmentId: a.environmentId,
        folderId: a.folderId,
        deploy: a.deploy ?? false,
      },
    }),
  }),
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
    name: "set_app_volumes",
    title: "Set an app's volumes",
    description:
      "Replace the app's volumes wholesale: pass the full list you want, not just the new one. Applied on the next deploy.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({
      appId,
      volumes: z
        .array(
          z.object({
            mountPath: z
              .string()
              .describe("Where it appears inside the container."),
            name: z
              .string()
              .optional()
              .describe("Named volume. Leave out for a bind mount."),
            hostPath: z
              .string()
              .optional()
              .describe("A path on the host. Needs the host-volumes grant."),
            service: z
              .string()
              .optional()
              .describe("Which container, on a compose app."),
            readOnly: z.boolean().optional(),
          }),
        )
        .describe("The complete set of volumes the app should have."),
    }),
    variables: (a) => ({ id: a.appId, volumes: a.volumes }),
    query: /* GraphQL */ `
      mutation McpSetAppVolumes($id: String!, $volumes: [VolumeInput!]!) {
        setAppVolumes(id: $id, volumes: $volumes) { ${APP_FIELDS} }
      }
    `,
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
  service
  port
  pathPrefix
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
      "Point a hostname at an app. Certificates stay off unless you ask for letsencrypt. A multi-container app also needs the container this hostname routes to.",
    group: "Domains",
    requires: "manage_domains",
    input: z.object({
      appId,
      name: z.string().describe("The hostname, e.g. api.acme.com."),
      service: z
        .string()
        .optional()
        .describe(
          "Multi-container app only, and required there: the compose service that serves this hostname. get_app returns the compose file with the names.",
        ),
      port: z
        .number()
        .int()
        .optional()
        .describe(
          "Container port to route to. Required on a multi-container app.",
        ),
      certProvider: z.enum(["none", "letsencrypt", "custom"]).optional(),
      pathPrefix: z
        .string()
        .optional()
        .describe(
          'Serve this app under a path of the hostname, e.g. "/api". Omit to serve the whole host.',
        ),
      stripPrefix: z
        .boolean()
        .optional()
        .describe(
          "Remove the path prefix before the container sees the request.",
        ),
    }),
    query: /* GraphQL */ `
      mutation McpAddDomain($appId: String!, $name: String!, $config: DomainConfigInput) {
        addDomain(appId: $appId, name: $name, config: $config) { ${DOMAIN_FIELDS} }
      }
    `,
    variables: (a) => ({
      appId: a.appId,
      name: a.name,
      config: {
        service: a.service,
        port: a.port,
        certProvider: a.certProvider,
        pathPrefix: a.pathPrefix,
        stripPrefix: a.stripPrefix,
      },
    }),
  }),
  tool({
    name: "update_domain",
    title: "Update a domain",
    description:
      "Change a domain that is already attached: its hostname, the container it routes to, its port or its certificate. Only what you pass changes.",
    group: "Domains",
    requires: "manage_domains",
    idempotent: true,
    input: z.object({
      id: z.string().describe("The domain's id, as returned by list_domains."),
      name: z.string().optional().describe("A different hostname."),
      service: z
        .string()
        .optional()
        .describe(
          "Multi-container app only: the compose service that serves it.",
        ),
      port: z.number().int().optional().describe("Container port to route to."),
      certProvider: z.enum(["none", "letsencrypt", "custom"]).optional(),
    }),
    query: /* GraphQL */ `
      mutation McpUpdateDomain($id: String!, $patch: DomainPatchInput!) {
        updateDomain(id: $id, patch: $patch) { ${DOMAIN_FIELDS} }
      }
    `,
    variables: (a) => ({
      id: a.id,
      patch: {
        name: a.name,
        service: a.service,
        port: a.port,
        certProvider: a.certProvider,
      },
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
      "Choose the canonical hostname; the app's URL follows it everywhere in Deplo.",
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
    name: "control_database",
    title: "Start, stop or restart a database",
    description:
      "Bring a database's container up, down, or round again. Data is untouched either way; rebuild_database is the one that erases it.",
    group: "Databases",
    requires: "control_databases",
    idempotent: true,
    input: z.object({
      id: databaseId,
      action: z.enum(["start", "stop", "restart"]),
    }),
    variables: (a) => ({
      id: a.id,
      running: a.action === "start",
      isRunning: a.action !== "restart",
      isRestart: a.action === "restart",
    }),
    query: /* GraphQL */ `
      mutation McpControlDatabase(
        $id: String!
        $running: Boolean!
        $isRunning: Boolean!
        $isRestart: Boolean!
      ) {
        setDatabaseRunning(id: $id, running: $running) @include(if: $isRunning) { ${DATABASE_FIELDS} }
        restartDatabase(id: $id) @include(if: $isRestart) { ${DATABASE_FIELDS} }
      }
    `,
  }),
  tool({
    name: "redeploy_database",
    title: "Redeploy a database",
    description:
      "Re-render and restart the database from its current settings, keeping the data. This is the verb for applying a change; rebuild_database is not.",
    group: "Databases",
    requires: "control_databases",
    idempotent: true,
    input: z.object({ id: databaseId }),
    query: /* GraphQL */ `
      mutation McpRedeployDatabase($id: String!) {
        redeployDatabase(id: $id) { ${DATABASE_FIELDS} }
      }
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
    name: "logs",
    title: "Read logs",
    description:
      "The tail of an app's or a database's container output. Truncated to stay readable; ask for fewer lines if you only need the end.",
    group: "Logs",
    requires: "view_logs",
    readOnly: true,
    idempotent: true,
    input: z.object({
      kind: z.enum(["app", "database"]).describe("What the id names."),
      id: z.string().describe("The app's or database's id."),
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
        .describe(
          "One container, by compose service name; defaults to the workload's own.",
        ),
    }),
    query: "",
    run: async (a) => {
      const { appLogsSnapshot, databaseLogsSnapshot } =
        await import("../data/logs-snapshot");
      const read = a.kind === "app" ? appLogsSnapshot : databaseLogsSnapshot;
      return read(a.id, { lines: a.lines, container: a.container });
    },
  }),
];

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/**
 * One target argument instead of three tools: `app_metrics` / `database_metrics`
 * / `server_metrics` differed only in which id they took, which is exactly the
 * shape a model picks wrong.
 */
const CONTAINER_METRICS = /* GraphQL */ `
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
`;

const METRICS: McpToolDef[] = [
  tool({
    name: "metrics",
    title: "Live metrics",
    description:
      "Live CPU, memory and I/O for an app, a database or a whole server. A server also reports disk, which is how you explain a build that failed on a full host.",
    group: "Monitoring",
    requires: "view_metrics",
    readOnly: true,
    idempotent: true,
    input: z.object({
      kind: z
        .enum(["app", "database", "server"])
        .describe("What the id names."),
      id: z.string().describe("The app's, database's or server's id."),
    }),
    variables: (a) => ({
      id: a.id,
      isApp: a.kind === "app",
      isDatabase: a.kind === "database",
      isServer: a.kind === "server",
    }),
    query: /* GraphQL */ `
      query McpMetrics(
        $id: String!
        $isApp: Boolean!
        $isDatabase: Boolean!
        $isServer: Boolean!
      ) {
        appMetrics(appId: $id) @include(if: $isApp) {
          ${CONTAINER_METRICS}
          blockRead
          blockWrite
          containers
        }
        databaseMetrics(databaseId: $id) @include(if: $isDatabase) {
          ${CONTAINER_METRICS}
        }
        serverMetrics(serverId: $id) @include(if: $isServer) {
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
    name: "run_backup",
    title: "Back up now",
    description:
      "Take a backup right now: of an app, of a database, or by running an existing schedule ahead of its time.",
    group: "Backups",
    requires: "manage_backups",
    input: z.object({
      kind: z
        .enum(["app", "database", "schedule"])
        .describe("What the id names."),
      id: z.string().describe("The app's, database's or schedule's id."),
      destinationId: z
        .string()
        .optional()
        .describe(
          "Where to store it, from list_destinations. Not used for a schedule, which carries its own.",
        ),
    }),
    variables: (a) => {
      if (a.kind !== "schedule" && !a.destinationId)
        throw new Error(
          "Backing up an app or a database needs a destinationId; see list_destinations.",
        );
      return {
        id: a.id,
        destinationId: a.destinationId ?? "",
        isApp: a.kind === "app",
        isDatabase: a.kind === "database",
        isSchedule: a.kind === "schedule",
      };
    },
    query: /* GraphQL */ `
      mutation McpRunBackup(
        $id: String!
        $destinationId: String!
        $isApp: Boolean!
        $isDatabase: Boolean!
        $isSchedule: Boolean!
      ) {
        runAppBackup(appId: $id, destinationId: $destinationId)
          @include(if: $isApp)
        runDatabaseBackup(databaseId: $id, destinationId: $destinationId)
          @include(if: $isDatabase)
        runBackup(id: $id) @include(if: $isSchedule)
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
    description:
      "Scheduled commands for one app or database, with the master switch and the containers a job can run in.",
    group: "Cron",
    requires: "manage_crons",
    readOnly: true,
    idempotent: true,
    input: z.object({
      id: z.string().describe("The app's or database's id."),
      kind: CRON_KIND,
    }),
    variables: (a) => ({ id: a.id, isDatabase: a.kind === "database" }),
    query: /* GraphQL */ `
      query McpListCronJobs($id: ID!, $isDatabase: Boolean!) {
        appCronJobs(appId: $id) @skip(if: $isDatabase) { enabled targetId services jobs { ${CRON_FIELDS} } }
        databaseCronJobs(databaseId: $id) @include(if: $isDatabase) { enabled targetId services jobs { ${CRON_FIELDS} } }
      }
    `,
  }),
  tool({
    name: "create_cron_job",
    title: "Create a cron job",
    description:
      "Schedule a command inside an app's or a database's container. The schedule is standard cron syntax.",
    group: "Cron",
    requires: "manage_crons",
    input: z.object({
      id: z.string().describe("The app's or database's id."),
      kind: CRON_KIND,
      name: z.string(),
      command: z.string(),
      schedule: z.string().describe('Cron syntax, e.g. "0 3 * * *".'),
      timezone: z.string().optional().describe("IANA zone, e.g. Europe/Rome."),
      description: z.string().optional(),
      service: z
        .string()
        .optional()
        .describe(
          "Multi-container app: the compose service to run the command in. Omitted, the job lands in whichever container of the stack is up.",
        ),
    }),
    query: /* GraphQL */ `
      mutation McpCreateCronJob($targetId: ID!, $targetKind: String!, $input: CronJobInput!) {
        createCronJob(targetId: $targetId, targetKind: $targetKind, input: $input) { ${CRON_FIELDS} }
      }
    `,
    variables: (a) => ({
      targetId: a.id,
      targetKind: a.kind ?? "app",
      input: {
        name: a.name,
        command: a.command,
        schedule: a.schedule,
        timezone: a.timezone,
        description: a.description,
        service: a.service,
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
    name: "move_app",
    title: "Move an app",
    description:
      "Move an app into a folder, a project or one of a project's environments. Pass exactly one target, or none at all to send it back to the top level.",
    group: "Organization",
    requires: "move_apps",
    idempotent: true,
    input: z.object({
      appId,
      folderId: z.string().optional().describe("A folder, from list_folders."),
      projectId: z
        .string()
        .optional()
        .describe("A project, from list_projects."),
      environmentId: z
        .string()
        .optional()
        .describe("An environment, from list_environments."),
    }),
    variables: (a) => {
      const targets = [a.folderId, a.projectId, a.environmentId].filter(
        Boolean,
      );
      if (targets.length > 1)
        throw new Error(
          "Pass one of folderId, projectId or environmentId, not several: an app lives in one place.",
        );
      return {
        appId: a.appId,
        folderId: a.folderId ?? null,
        projectId: a.projectId ?? null,
        environmentId: a.environmentId ?? "",
        isEnvironment: Boolean(a.environmentId),
        isProject: Boolean(a.projectId),
        // No target at all means the top level, which is a folder move to null.
        isFolder: !a.projectId && !a.environmentId,
      };
    },
    query: /* GraphQL */ `
      mutation McpMoveApp(
        $appId: ID!
        $folderId: ID
        $projectId: ID
        $environmentId: ID!
        $isFolder: Boolean!
        $isProject: Boolean!
        $isEnvironment: Boolean!
      ) {
        moveAppToFolder(appId: $appId, folderId: $folderId)
          @include(if: $isFolder)
        moveAppToProject(appId: $appId, projectId: $projectId)
          @include(if: $isProject)
        moveAppToEnvironment(appId: $appId, environmentId: $environmentId)
          @include(if: $isEnvironment)
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
      "Update the Deplo agent binary on one host in place. Agent releases are forward-only: this cannot be undone.",
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

/* ------------------------------------------------------------------ *
 * Shared variables
 * ------------------------------------------------------------------ */

const SHARED_ENV: McpToolDef[] = [
  tool({
    name: "list_shared_vars",
    title: "List shared variables",
    description:
      "Variables the whole team can reuse, with which apps each one is linked to. Secret values are masked, as everywhere else.",
    group: "Environment",
    requires: "manage_env",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpSharedVars {
        sharedVars {
          id
          key
          type
          masked
          teamWide
          autoInject
          appIds
          updatedAt
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Backup schedules
 * ------------------------------------------------------------------ */

const BACKUP_SCHEDULES: McpToolDef[] = [
  tool({
    name: "set_backup_schedule",
    title: "Create or edit a backup schedule",
    description:
      "Set up a recurring backup, or change one that exists by passing its id. Pass enabled on its own to just turn one on or off.",
    group: "Backups",
    requires: "manage_backups",
    input: z.object({
      id: z
        .string()
        .optional()
        .describe("An existing schedule, from list_backups. Omit to create."),
      name: z.string().optional(),
      appId: z.string().optional().describe("Back up an app. Create only."),
      databaseId: z
        .string()
        .optional()
        .describe("Back up a database. Create only."),
      destinationId: z
        .string()
        .optional()
        .describe("Where it is stored, from list_destinations."),
      schedule: z.string().optional().describe("5-field cron, e.g. 0 3 * * *."),
      retentionCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("How many artifacts to keep."),
      timezone: z.string().optional().describe("IANA zone, e.g. Europe/Rome."),
      enabled: z.boolean().optional().describe("Turn a schedule on or off."),
    }),
    variables: (a) => {
      const toggleOnly =
        Boolean(a.id) &&
        a.enabled !== undefined &&
        !a.name &&
        !a.destinationId &&
        !a.schedule &&
        a.retentionCount === undefined;
      if (!a.id) {
        if (!a.name || !a.destinationId || !a.schedule)
          throw new Error(
            "Creating a schedule needs name, destinationId and schedule.",
          );
        if (!a.appId && !a.databaseId)
          throw new Error(
            "Creating a schedule needs an appId or a databaseId.",
          );
      } else if (!toggleOnly && (!a.name || !a.destinationId || !a.schedule)) {
        throw new Error(
          "Editing a schedule needs name, destinationId and schedule; pass enabled alone to only switch it on or off.",
        );
      }
      // Both input objects are coerced whatever `@include` says, so the branch
      // that is off still needs values its type accepts.
      const fields = {
        name: a.name ?? "",
        destinationId: a.destinationId ?? "",
        schedule: a.schedule ?? "",
        retentionCount: a.retentionCount ?? 7,
        timezone: a.timezone,
      };
      return {
        id: a.id ?? "",
        enabled: a.enabled ?? true,
        create: { ...fields, appId: a.appId, databaseId: a.databaseId },
        update: fields,
        isCreate: !a.id,
        isUpdate: Boolean(a.id) && !toggleOnly,
        isToggle: Boolean(a.id) && a.enabled !== undefined,
      };
    },
    query: /* GraphQL */ `
      mutation McpSetBackupSchedule(
        $id: String!
        $enabled: Boolean!
        $create: CreateBackupInput!
        $update: UpdateBackupInput!
        $isCreate: Boolean!
        $isUpdate: Boolean!
        $isToggle: Boolean!
      ) {
        createBackup(input: $create) @include(if: $isCreate)
        updateBackup(id: $id, input: $update) @include(if: $isUpdate)
        toggleBackup(id: $id, enabled: $enabled) @include(if: $isToggle)
      }
    `,
  }),
  tool({
    name: "delete_backup_schedule",
    title: "Delete a backup schedule",
    description:
      "Stop a recurring backup and forget its schedule. Artifacts already stored are left where they are.",
    group: "Backups",
    requires: "manage_backups",
    destructive: true,
    input: z.object({ id: z.string().describe("From list_backups.") }),
    query: /* GraphQL */ `
      mutation McpDeleteBackupSchedule($id: String!) {
        deleteBackup(id: $id)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Git sources - what create_app needs before it can name a repo
 * ------------------------------------------------------------------ */

const GIT: McpToolDef[] = [
  tool({
    name: "list_git_sources",
    title: "List git connections",
    description:
      "The GitHub installations and other git connections this team can build from. Start here when you need a repo and do not know its URL.",
    group: "Git",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpGitSources {
        githubInstallations {
          id
          installationId
          accountLogin
          accountType
        }
        gitConnections {
          id
          label
          provider
          accountLogin
          baseUrl
          hasApi
          health
        }
      }
    `,
  }),
  tool({
    name: "list_repos",
    title: "List repositories or branches",
    description:
      "Repositories a git source can reach, or a repository's branches when you name one. Ids come from list_git_sources.",
    group: "Git",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({
      installationId: z
        .string()
        .optional()
        .describe("A GitHub installation, from list_git_sources."),
      connectionId: z
        .string()
        .optional()
        .describe("A non-GitHub git connection, from list_git_sources."),
      repo: z
        .string()
        .optional()
        .describe("owner/name. Given, this lists branches instead of repos."),
    }),
    variables: (a) => {
      if (Boolean(a.installationId) === Boolean(a.connectionId))
        throw new Error(
          "Pass exactly one of installationId or connectionId; see list_git_sources.",
        );
      const github = Boolean(a.installationId);
      const branches = Boolean(a.repo);
      return {
        installationId: a.installationId ?? "",
        connectionId: a.connectionId ?? "",
        repo: a.repo ?? "",
        isGithubRepos: github && !branches,
        isGithubBranches: github && branches,
        isGitRepos: !github && !branches,
        isGitBranches: !github && branches,
      };
    },
    query: /* GraphQL */ `
      query McpRepos(
        $installationId: String!
        $connectionId: String!
        $repo: String!
        $isGithubRepos: Boolean!
        $isGithubBranches: Boolean!
        $isGitRepos: Boolean!
        $isGitBranches: Boolean!
      ) {
        githubRepos(installationId: $installationId)
          @include(if: $isGithubRepos) {
          fullName
          defaultBranch
          private
          updatedAt
        }
        githubBranches(installationId: $installationId, fullName: $repo)
          @include(if: $isGithubBranches)
        gitRepos(connectionId: $connectionId) @include(if: $isGitRepos) {
          fullName
          defaultBranch
          private
          updatedAt
        }
        gitBranches(connectionId: $connectionId, fullName: $repo)
          @include(if: $isGitBranches)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Registries and an app's Access tab
 * ------------------------------------------------------------------ */

const REGISTRIES_AND_ACCESS: McpToolDef[] = [
  tool({
    name: "list_registries",
    title: "List registry credentials",
    description:
      "Registries this team can pull private images from. Passwords are never returned.",
    group: "Registries",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpRegistries {
        registries {
          id
          name
          type
          registryUrl
          username
          createdAt
        }
      }
    `,
  }),
  tool({
    name: "add_registry",
    title: "Add a registry credential",
    description:
      "Store a login for a private image registry, so apps on this team can pull from it.",
    group: "Registries",
    requires: "manage_registries",
    input: z.object({
      name: z.string().describe("How it is labelled in Deplo."),
      type: z
        .string()
        .describe("Registry kind, e.g. dockerhub, ghcr, gitlab, custom."),
      username: z.string(),
      password: z.string().describe("Stored encrypted and never read back."),
      registryUrl: z
        .string()
        .optional()
        .describe("Only for a custom registry."),
    }),
    variables: (a) => ({
      input: {
        name: a.name,
        type: a.type,
        username: a.username,
        password: a.password,
        registryUrl: a.registryUrl,
      },
    }),
    query: /* GraphQL */ `
      mutation McpAddRegistry($input: AddRegistryInput!) {
        addRegistry(input: $input)
      }
    `,
  }),
  tool({
    name: "delete_registry",
    title: "Delete a registry credential",
    description:
      "Forget a registry login. Apps still pointing at it stop being able to pull.",
    group: "Registries",
    requires: "manage_registries",
    destructive: true,
    input: z.object({ id: z.string().describe("From list_registries.") }),
    query: /* GraphQL */ `
      mutation McpDeleteRegistry($id: String!) {
        deleteRegistry(id: $id)
      }
    `,
  }),
  tool({
    name: "list_basic_auth_users",
    title: "List an app's basic-auth logins",
    description:
      "Usernames that have to sign in before an app's domains answer. Passwords are never returned, by design.",
    group: "Access",
    requires: "manage_basic_auth",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      query McpBasicAuthUsers($appId: String!) {
        basicAuthUsers(appId: $appId) {
          id
          username
          createdAt
          updatedAt
        }
      }
    `,
  }),
  tool({
    name: "set_basic_auth_user",
    title: "Add a basic-auth login, or change its password",
    description:
      "Put a username and password in front of every domain of an app. Pass id to change an existing login's password instead.",
    group: "Access",
    requires: "manage_basic_auth",
    input: z.object({
      appId: z.string().optional().describe("The app. Required to add."),
      id: z
        .string()
        .optional()
        .describe("An existing login, to change its password."),
      username: z.string().optional().describe("Required to add."),
      password: z.string(),
    }),
    variables: (a) => {
      if (!a.id && (!a.appId || !a.username))
        throw new Error(
          "Adding a login needs appId and username; pass id instead to change an existing one's password.",
        );
      return {
        appId: a.appId ?? "",
        id: a.id ?? "",
        username: a.username ?? "",
        password: a.password,
        isAdd: !a.id,
        isUpdate: Boolean(a.id),
      };
    },
    query: /* GraphQL */ `
      mutation McpSetBasicAuthUser(
        $appId: String!
        $id: String!
        $username: String!
        $password: String!
        $isAdd: Boolean!
        $isUpdate: Boolean!
      ) {
        addBasicAuthUser(
          appId: $appId
          username: $username
          password: $password
        ) @include(if: $isAdd) {
          id
          username
        }
        updateBasicAuthUserPassword(id: $id, password: $password)
          @include(if: $isUpdate) {
          id
          username
        }
      }
    `,
  }),
  tool({
    name: "remove_basic_auth_user",
    title: "Remove a basic-auth login",
    description:
      "Delete one login, so it stops working within seconds. The app's domains stay protected by whatever logins remain.",
    group: "Access",
    requires: "manage_basic_auth",
    destructive: true,
    input: z.object({
      id: z.string().describe("From list_basic_auth_users."),
    }),
    query: /* GraphQL */ `
      mutation McpRemoveBasicAuthUser($id: String!) {
        removeBasicAuthUser(id: $id)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Escape hatch
 * ------------------------------------------------------------------ */

const PASSTHROUGH_VARIABLES = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Values for the document's variables.");

/** Runs a document the model wrote, as the token's own principal. */
async function passthrough(
  args: { query: string; variables?: Record<string, unknown> },
  ctx: GraphQLContext,
  kind: "query" | "mutation",
) {
  const { admitPassthrough, runGraphql } = await import("./execute");
  const { data, error } = await runGraphql(
    admitPassthrough(args.query, kind),
    args.variables ?? {},
    ctx,
  );
  // Thrown, not returned: the handler's catch is what turns it into an isError
  // result, and a `run` tool's value is otherwise reported as success.
  if (error) throw new Error(error);
  return data;
}

const ESCAPE_HATCH: McpToolDef[] = [
  tool({
    name: "graphql_query",
    title: "Run a GraphQL read",
    description:
      'Last resort: read anything the curated tools do not cover, straight from Deplo\'s GraphQL API. Discover fields with __type(name: "Query"). Ask for few fields at a time.',
    group: "Escape hatch",
    requires: null,
    readOnly: true,
    idempotent: true,
    input: z.object({
      query: z
        .string()
        .describe("A GraphQL query document. Mutations are refused here."),
      variables: PASSTHROUGH_VARIABLES,
    }),
    query: "",
    run: (a, ctx) => passthrough(a, ctx, "query"),
  }),
  tool({
    name: "graphql_mutate",
    title: "Run a GraphQL write",
    description:
      'Last resort: a write no curated tool covers, straight from Deplo\'s GraphQL API. Prefer a named tool where one exists. Discover fields with graphql_query and __type(name: "Mutation").',
    group: "Escape hatch",
    requires: null,
    // One tool covering every write, from a rename to a deletion, so the client
    // has to ask. What it may actually DO is still the token's Capabilities.
    destructive: true,
    input: z.object({
      query: z
        .string()
        .describe("A GraphQL mutation document. Queries are refused here."),
      variables: PASSTHROUGH_VARIABLES,
    }),
    query: "",
    run: (a, ctx) => passthrough(a, ctx, "mutation"),
  }),
];

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
  ...SHARED_ENV,
  ...BACKUP_SCHEDULES,
  ...GIT,
  ...REGISTRIES_AND_ACCESS,
  ...SERVERS,
  ...ESCAPE_HATCH,
];

/** Group order for the settings table, derived so the two cannot drift. */
export const MCP_TOOL_GROUPS: string[] = [
  ...new Set(MCP_TOOLS.map((t) => t.group)),
];
