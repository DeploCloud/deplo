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
      "Which Deplo team this call ran in (the default when no `team` is passed), and what this token is allowed to do. Run this first when something is refused.",
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
      }
    `,
  }),
  tool({
    name: "list_teams",
    title: "List teams",
    description:
      "Every team this connection can name, with whether it can act there. To work in one, pass its id or slug as the `team` argument of any other tool - that is the only way to change team.",
    group: "Diagnostics",
    requires: null,
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListTeams {
        mcpTeams {
          id
          name
          slug
          mcpEnabled
          canConnect
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

/* ------------------------------------------------------------------ *
 * Projects, environments, folders, shared variables
 * ------------------------------------------------------------------ */

const STRUCTURE: McpToolDef[] = [
  tool({
    name: "get_project",
    title: "Get a project",
    description:
      "One project with its environments, by slug (from list_projects).",
    group: "Organization",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({ slug: z.string() }),
    query: /* GraphQL */ `
      query McpGetProject($slug: String!) {
        project(slug: $slug) {
          id
          name
          slug
          color
          appCount
          folderCount
          environments {
            id
            name
            slug
            kind
            isDefault
            gitBranch
            position
          }
        }
      }
    `,
  }),
  tool({
    name: "create_project",
    title: "Create a project",
    description:
      "Create a project: an advanced folder with environments (production by default) that own their own apps and variables.",
    group: "Organization",
    requires: "create_projects",
    input: z.object({
      name: z.string(),
      color: z.string().optional().describe("Hex accent colour."),
    }),
    query: /* GraphQL */ `
      mutation McpCreateProject($name: String!, $color: String) {
        createProject(name: $name, color: $color) {
          id
          name
          slug
        }
      }
    `,
  }),
  tool({
    name: "update_project",
    title: "Rename or recolour a project",
    description: "Change a project's name and/or its accent colour.",
    group: "Organization",
    requires: "organize_projects",
    idempotent: true,
    input: z.object({
      id: z.string().describe("The project's id, from list_projects."),
      name: z.string().optional(),
      color: z
        .string()
        .nullable()
        .optional()
        .describe("Hex accent colour, or null to clear it."),
    }),
    variables: (a) => {
      if (a.name === undefined && a.color === undefined)
        throw new Error("Pass a name, a color, or both.");
      return {
        id: a.id,
        name: a.name ?? "",
        color: a.color ?? null,
        rename: a.name !== undefined,
        recolour: a.color !== undefined,
      };
    },
    query: /* GraphQL */ `
      mutation McpUpdateProject(
        $id: ID!
        $name: String!
        $color: String
        $rename: Boolean!
        $recolour: Boolean!
      ) {
        renameProject(id: $id, name: $name) @include(if: $rename)
        setProjectColor(id: $id, color: $color) @include(if: $recolour)
      }
    `,
  }),
  tool({
    name: "delete_project",
    title: "Delete a project",
    description:
      "Delete a project and its environments. Its apps are moved to the top level unless deleteApps is true, which destroys them too.",
    group: "Organization",
    requires: "delete_projects",
    destructive: true,
    input: z.object({
      id: z.string().describe("The project's id, from list_projects."),
      deleteApps: z
        .boolean()
        .optional()
        .describe("Also delete every app inside it. Default false."),
    }),
    query: /* GraphQL */ `
      mutation McpDeleteProject($id: ID!, $deleteApps: Boolean) {
        deleteProject(id: $id, deleteApps: $deleteApps)
      }
    `,
  }),
  tool({
    name: "create_environment",
    title: "Create an environment",
    description:
      "Add an environment (staging, preview...) to a project. Each one owns its own apps, shared variables and network.",
    group: "Organization",
    requires: "manage_environments",
    input: z.object({
      projectId: z.string().describe("From list_projects."),
      name: z.string(),
    }),
    query: /* GraphQL */ `
      mutation McpCreateEnvironment($projectId: ID!, $name: String!) {
        createEnvironment(projectId: $projectId, name: $name) {
          id
          name
          slug
          isDefault
        }
      }
    `,
  }),
  tool({
    name: "update_environment",
    title: "Update an environment",
    description:
      "Rename an environment, make it the project's default, or set the git branch its apps deploy from.",
    group: "Organization",
    requires: "manage_environments",
    idempotent: true,
    input: z.object({
      id: z.string().describe("From list_environments."),
      name: z.string().optional(),
      makeDefault: z.boolean().optional().describe("Make it the default."),
      branch: z
        .string()
        .optional()
        .describe("Git branch the environment tracks."),
    }),
    variables: (a) => {
      if (a.name === undefined && !a.makeDefault && a.branch === undefined)
        throw new Error("Pass a name, makeDefault or a branch.");
      return {
        id: a.id,
        name: a.name ?? "",
        branch: a.branch ?? "",
        rename: a.name !== undefined,
        makeDefault: a.makeDefault === true,
        setBranch: a.branch !== undefined,
      };
    },
    query: /* GraphQL */ `
      mutation McpUpdateEnvironment(
        $id: ID!
        $name: String!
        $branch: String!
        $rename: Boolean!
        $makeDefault: Boolean!
        $setBranch: Boolean!
      ) {
        renameEnvironment(id: $id, name: $name) @include(if: $rename)
        setDefaultEnvironment(id: $id) @include(if: $makeDefault)
        setEnvironmentBranch(id: $id, branch: $branch) @include(if: $setBranch)
      }
    `,
  }),
  tool({
    name: "delete_environment",
    title: "Delete an environment",
    description:
      "Delete a project's environment and everything deployed in it. The default environment cannot be deleted.",
    group: "Organization",
    requires: "manage_environments",
    destructive: true,
    input: z.object({ id: z.string().describe("From list_environments.") }),
    query: /* GraphQL */ `
      mutation McpDeleteEnvironment($id: ID!) {
        deleteEnvironment(id: $id)
      }
    `,
  }),
  tool({
    name: "update_folder",
    title: "Rename, recolour or move a folder",
    description:
      "Change a folder's name or accent colour, or move it under another folder (parentId null moves it to the top level).",
    group: "Organization",
    requires: "organize_folders",
    idempotent: true,
    input: z.object({
      id: z.string().describe("From list_folders."),
      name: z.string().optional(),
      color: z.string().nullable().optional().describe("Hex, or null."),
      parentId: z
        .string()
        .nullable()
        .optional()
        .describe("New parent folder, or null for the top level."),
    }),
    variables: (a) => {
      if (
        a.name === undefined &&
        a.color === undefined &&
        a.parentId === undefined
      )
        throw new Error("Pass a name, a color or a parentId.");
      return {
        id: a.id,
        name: a.name ?? "",
        color: a.color ?? null,
        parentId: a.parentId ?? null,
        rename: a.name !== undefined,
        recolour: a.color !== undefined,
        move: a.parentId !== undefined,
      };
    },
    query: /* GraphQL */ `
      mutation McpUpdateFolder(
        $id: ID!
        $name: String!
        $color: String
        $parentId: ID
        $rename: Boolean!
        $recolour: Boolean!
        $move: Boolean!
      ) {
        renameFolder(id: $id, name: $name) @include(if: $rename)
        setFolderColor(id: $id, color: $color) @include(if: $recolour)
        moveFolder(id: $id, parentId: $parentId) @include(if: $move)
      }
    `,
  }),
  tool({
    name: "delete_folder",
    title: "Delete a folder",
    description:
      "Delete a folder. Its apps move to the top level unless deleteApps is true, which destroys them too.",
    group: "Organization",
    requires: "delete_folders",
    destructive: true,
    input: z.object({
      id: z.string().describe("From list_folders."),
      deleteApps: z.boolean().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpDeleteFolder($id: ID!, $deleteApps: Boolean) {
        deleteFolder(id: $id, deleteApps: $deleteApps)
      }
    `,
  }),
  tool({
    name: "move_apps_to_folder",
    title: "Move several apps into a folder",
    description:
      "File many apps into one folder at once, or pass no folderId to send them back to the top level.",
    group: "Organization",
    requires: "move_apps",
    idempotent: true,
    input: z.object({
      appIds: z.array(z.string()).min(1),
      folderId: z.string().nullable().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpMoveAppsToFolder($appIds: [ID!]!, $folderId: ID) {
        moveAppsToFolder(appIds: $appIds, folderId: $folderId)
      }
    `,
  }),
  tool({
    name: "list_folder_grants",
    title: "List who can access a folder",
    description:
      "The people granted access to a folder and what each may do there, plus which capabilities you could grant.",
    group: "Organization",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({ folderId: z.string().describe("From list_folders.") }),
    query: /* GraphQL */ `
      query McpFolderGrants($folderId: ID!) {
        folderGrants(folderId: $folderId) {
          userId
          username
          name
          isOwner
          capabilities
        }
        grantableFolderCapabilities(folderId: $folderId)
      }
    `,
  }),
  tool({
    name: "set_folder_grant",
    title: "Grant or change someone's access to a folder",
    description:
      "Give a member access to a folder with exactly these capabilities, replacing any grant they had. Pass an empty list to remove them.",
    group: "Organization",
    requires: "organize_folders",
    idempotent: true,
    input: z.object({
      folderId: z.string().describe("From list_folders."),
      userId: z.string().describe("From list_members."),
      capabilities: z
        .array(z.string())
        .describe("Capability names. Empty removes the grant."),
    }),
    variables: (a) => ({
      folderId: a.folderId,
      userId: a.userId,
      capabilities: a.capabilities,
      remove: a.capabilities.length === 0,
      grant: a.capabilities.length > 0,
    }),
    query: /* GraphQL */ `
      mutation McpSetFolderGrant(
        $folderId: ID!
        $userId: ID!
        $capabilities: [String!]!
        $grant: Boolean!
        $remove: Boolean!
      ) {
        setFolderGrant(
          folderId: $folderId
          userId: $userId
          capabilities: $capabilities
        ) @include(if: $grant) {
          userId
          capabilities
        }
        removeFolderGrant(folderId: $folderId, userId: $userId)
          @include(if: $remove) {
          userId
          capabilities
        }
      }
    `,
  }),
  tool({
    name: "list_app_shared_vars",
    title: "List the shared variables an app can use",
    description:
      "Every shared variable in reach of one app, and whether it is linked (injected) into it. Values are masked.",
    group: "Environment",
    requires: "manage_env",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      query McpAppSharedVars($appId: String!) {
        sharedVarsForApp(appId: $appId) {
          id
          key
          type
          masked
          scope
          linked
          inScope
          autoInject
          targets
          ownerTeamName
        }
      }
    `,
  }),
  tool({
    name: "save_shared_var",
    title: "Create or edit a shared variable",
    description:
      "Create a shared variable, or change one by passing its id. Say where it applies: whole teams, projects, environments or single apps. Linking it to an app is a separate step (link_shared_var).",
    group: "Environment",
    requires: "manage_env",
    input: z.object({
      id: z.string().optional().describe("Edit this one; omit to create."),
      key: z.string(),
      value: z.string(),
      secret: z.boolean().optional().describe("Store it masked."),
      teamIds: z.array(z.string()).optional(),
      projectIds: z.array(z.string()).optional(),
      environmentIds: z.array(z.string()).optional(),
      appIds: z.array(z.string()).optional(),
      targets: z
        .array(z.enum(["production", "preview"]))
        .optional()
        .describe("Where it is injected. Default both."),
    }),
    variables: (a) => ({
      input: {
        id: a.id,
        key: a.key,
        value: a.value,
        type: a.secret ? "secret" : "plain",
        teamIds: a.teamIds ?? [],
        projectIds: a.projectIds ?? [],
        environmentIds: a.environmentIds ?? [],
        appIds: a.appIds,
        targets: a.targets,
      },
    }),
    query: /* GraphQL */ `
      mutation McpSaveSharedVar($input: SaveSharedVarInput!) {
        saveSharedVar(input: $input) {
          id
          key
          type
          teamWide
          appIds
        }
      }
    `,
  }),
  tool({
    name: "link_shared_var",
    title: "Link or unlink a shared variable to an app",
    description:
      "Inject a shared variable into an app (linked true) or stop (false). Shared variables are opt-in per app.",
    group: "Environment",
    requires: "manage_env",
    idempotent: true,
    input: z.object({
      varId: z.string().describe("From list_shared_vars."),
      appId,
      linked: z.boolean(),
    }),
    query: /* GraphQL */ `
      mutation McpLinkSharedVar(
        $varId: String!
        $appId: String!
        $linked: Boolean!
      ) {
        setSharedVarAppLink(varId: $varId, appId: $appId, linked: $linked)
      }
    `,
  }),
  tool({
    name: "delete_shared_var",
    title: "Delete a shared variable",
    description:
      "Remove a shared variable from every app it was linked to. Takes effect on their next deploy.",
    group: "Environment",
    requires: "manage_env",
    destructive: true,
    input: z.object({ id: z.string().describe("From list_shared_vars.") }),
    query: /* GraphQL */ `
      mutation McpDeleteSharedVar($id: String!) {
        deleteSharedVar(id: $id)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Roles, members, team
 * ------------------------------------------------------------------ */

const ROLE_SCOPE = z
  .object({
    projectIds: z.array(z.string()).optional(),
    environmentIds: z.array(z.string()).optional(),
    folderIds: z.array(z.string()).optional(),
    appIds: z.array(z.string()).optional(),
  })
  .optional()
  .describe("Limit the role to part of the team. Omit for the whole team.");

const TEAM_ADMIN: McpToolDef[] = [
  tool({
    name: "list_roles",
    title: "List the team's roles",
    description:
      "Every role of this team with its capabilities, scope and how many members hold it.",
    group: "Team",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListRoles {
        teamRoles {
          id
          name
          description
          builtinKey
          locked
          modified
          memberCount
          requireTwoFactor
          capabilities
        }
      }
    `,
  }),
  tool({
    name: "create_role",
    title: "Create a role",
    description:
      "Create a team role with exactly these capabilities. You can only give a role what you hold yourself.",
    group: "Team",
    requires: "manage_roles",
    input: z.object({
      name: z.string(),
      description: z.string().optional(),
      capabilities: z.array(z.string()).describe("Capability names."),
      requireTwoFactor: z.boolean().optional(),
      scope: ROLE_SCOPE,
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpCreateRole($input: CreateRoleInput!) {
        createRole(input: $input) {
          id
          name
          capabilities
        }
      }
    `,
  }),
  tool({
    name: "update_role",
    title: "Edit a role",
    description:
      "Rewrite a role's name, capabilities or scope. Every member holding it changes with it, immediately.",
    group: "Team",
    requires: "manage_roles",
    idempotent: true,
    input: z.object({
      id: z.string().describe("From list_roles."),
      name: z.string(),
      description: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      requireTwoFactor: z.boolean().optional(),
      scope: ROLE_SCOPE,
      clearScope: z.boolean().optional().describe("Make it team-wide again."),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpUpdateRole($input: UpdateRoleInput!) {
        updateRole(input: $input)
      }
    `,
  }),
  tool({
    name: "delete_role",
    title: "Delete a role",
    description:
      "Delete a custom role. Refused while a member still holds it; reassign them first with update_member.",
    group: "Team",
    requires: "manage_roles",
    destructive: true,
    input: z.object({ id: z.string().describe("From list_roles.") }),
    query: /* GraphQL */ `
      mutation McpDeleteRole($id: String!) {
        deleteRole(id: $id)
      }
    `,
  }),
  tool({
    name: "reset_role",
    title: "Reset a default role",
    description: "Put one of the three default roles back to what Deplo ships.",
    group: "Team",
    requires: "manage_roles",
    idempotent: true,
    input: z.object({ id: z.string().describe("From list_roles.") }),
    query: /* GraphQL */ `
      mutation McpResetRole($id: String!) {
        resetRole(id: $id)
      }
    `,
  }),
  tool({
    name: "add_member",
    title: "Add an existing user to the team",
    description:
      "Add a user who already has an account on this Deplo to this team, with a role (roleId from list_roles) or a hand-picked capability set.",
    group: "Team",
    requires: "manage_members",
    input: z.object({
      userId: z.string().describe("The user's id."),
      roleId: z.string().optional().describe("A role, from list_roles."),
      capabilities: z
        .array(z.string())
        .optional()
        .describe("A custom set instead of a role."),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpAddMember($input: AddMemberInput!) {
        addExistingMember(input: $input) {
          userId
          username
          roleName
          capabilities
        }
      }
    `,
  }),
  tool({
    name: "update_member",
    title: "Change a member's role or access",
    description:
      "Give a member another role (roleId) or a hand-picked capability set. Their API tokens and agents narrow with them, live.",
    group: "Team",
    requires: "manage_members",
    idempotent: true,
    input: z.object({
      userId: z.string().describe("From list_members."),
      roleId: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpUpdateMember($input: UpdateMemberInput!) {
        updateMember(input: $input) {
          userId
          username
          roleName
          capabilities
        }
      }
    `,
  }),
  tool({
    name: "remove_member",
    title: "Remove a member from the team",
    description:
      "Take a person out of this team. Every API token and AI agent of theirs stops acting here at once.",
    group: "Team",
    requires: "manage_members",
    destructive: true,
    input: z.object({ userId: z.string().describe("From list_members.") }),
    query: /* GraphQL */ `
      mutation McpRemoveMember($userId: String!) {
        removeMember(userId: $userId)
      }
    `,
  }),
  tool({
    name: "update_team",
    title: "Rename the team or set its two-factor policy",
    description:
      "Change the team's name, or require two-factor authentication of every member.",
    group: "Team",
    requires: "manage_team",
    idempotent: true,
    input: z.object({
      name: z.string().optional(),
      requireTwoFactor: z.boolean().optional(),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpUpdateTeam($input: UpdateTeamInput!) {
        updateTeam(input: $input) {
          id
          name
          slug
          requireTwoFactor
        }
      }
    `,
  }),
  tool({
    name: "transfer_app",
    title: "Move an app to another team",
    description:
      "Transfer an app, with its data, to another team you belong to. Needs move_apps here and create_apps there.",
    group: "Team",
    requires: "move_apps",
    input: z.object({
      appId,
      teamId: z.string().describe("The destination team, from list_teams."),
    }),
    query: /* GraphQL */ `
      mutation McpTransferApp($appId: String!, $teamId: String!) {
        transferAppToTeam(appId: $appId, teamId: $teamId)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * App settings the first table did not reach
 * ------------------------------------------------------------------ */

const APP_FIELDS_SETTINGS = /* GraphQL */ `
  id
  slug
  name
  framework
  frameworkDetected
  buildServerId
  buildFallback
  rollbackKeep
  deployHookEnabled
  composeUpArgs
  ports {
    published
    target
    protocol
  }
  healthCheck {
    type
    path
    port
    command
    intervalS
    timeoutS
    retries
    startPeriodS
  }
`;

const APPS_SETTINGS: McpToolDef[] = [
  tool({
    name: "get_app_runtime",
    title: "Get an app's containers",
    description:
      "The live containers of an app or database: how many run, restart or are unhealthy, and each one's state.",
    group: "Apps",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({
      id: z.string().describe("The app's or database's id."),
      kind: CRON_KIND,
    }),
    variables: (a) => ({ id: a.id, isDatabase: a.kind === "database" }),
    query: /* GraphQL */ `
      query McpRuntime($id: String!, $isDatabase: Boolean!) {
        appRuntime(appId: $id) @skip(if: $isDatabase) {
          total
          running
          restarting
          unhealthy
          unreachable
          missing
          containers {
            name
            service
            state
            health
            running
            restartCount
          }
        }
        databaseRuntime(databaseId: $id) @include(if: $isDatabase) {
          total
          running
          restarting
          unhealthy
          unreachable
          missing
          containers {
            name
            service
            state
            health
            running
            restartCount
          }
        }
      }
    `,
  }),
  tool({
    name: "set_env",
    title: "Replace an app's environment variables",
    description:
      "Rewrite the app's whole variable list at once: what is not in the list is removed. Use set_env_var to change one.",
    group: "Environment",
    requires: "manage_env",
    idempotent: true,
    destructive: true,
    input: z.object({
      appId,
      entries: z.array(z.object({ key: z.string(), value: z.string() })),
      defaultTargets: z
        .array(z.enum(["production", "preview"]))
        .optional()
        .describe("Where new keys are injected. Default both."),
    }),
    query: /* GraphQL */ `
      mutation McpSetEnv(
        $appId: String!
        $entries: [EnvEntryInput!]!
        $defaultTargets: [EnvTarget!]
      ) {
        setAppEnv(
          appId: $appId
          entries: $entries
          defaultTargets: $defaultTargets
        )
      }
    `,
  }),
  tool({
    name: "set_app_ports",
    title: "Publish ports on the host",
    description:
      "Expose container ports directly on the server (TCP/UDP), bypassing Traefik. The whole list at once; empty unpublishes all.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({
      appId,
      ports: z.array(
        z.object({
          published: z.number().int().describe("Host port."),
          target: z.number().int().describe("Container port."),
          protocol: z.enum(["tcp", "udp"]).optional(),
        }),
      ),
    }),
    variables: (a) => ({ id: a.appId, ports: a.ports }),
    query: /* GraphQL */ `
      mutation McpSetAppPorts($id: String!, $ports: [PublishedPortInput!]!) {
        setAppPorts(id: $id, ports: $ports) { ${APP_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_app_framework",
    title: "Override the detected framework",
    description:
      "Pin the framework preset a build uses, or pass null to go back to auto-detection.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({
      appId,
      framework: z.string().nullable(),
    }),
    variables: (a) => ({ id: a.appId, framework: a.framework }),
    query: /* GraphQL */ `
      mutation McpSetAppFramework($id: String!, $framework: String) {
        setAppFramework(id: $id, framework: $framework) { ${APP_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_app_health_check",
    title: "Set an app's health check",
    description:
      "Define how Deplo decides a container is healthy: an HTTP path or a command, with timings. Pass null to remove it.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({
      appId,
      healthCheck: z
        .object({
          type: z.enum(["http", "command"]),
          path: z.string().optional(),
          port: z.number().int().optional(),
          command: z.string().optional(),
          intervalS: z.number().int().default(30),
          timeoutS: z.number().int().default(10),
          retries: z.number().int().default(3),
          startPeriodS: z.number().int().default(30),
        })
        .nullable(),
    }),
    variables: (a) => ({ id: a.appId, input: a.healthCheck }),
    query: /* GraphQL */ `
      mutation McpSetHealthCheck($id: String!, $input: HealthCheckInput) {
        updateAppHealthCheck(id: $id, input: $input) { ${APP_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_app_rollback_keep",
    title: "Set how many builds are kept for rollback",
    description:
      "How many past images stay on the server so rollback_deployment can re-run them without a rebuild.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({ appId, count: z.number().int().min(0) }),
    variables: (a) => ({ id: a.appId, count: a.count }),
    query: /* GraphQL */ `
      mutation McpSetRollbackKeep($id: String!, $count: Int!) {
        setAppRollbackKeep(id: $id, count: $count) { ${APP_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_app_build_server",
    title: "Choose where an app is built",
    description:
      "Build on another server (from list_build_servers) instead of the one that runs the app, optionally falling back when it is down.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({
      appId,
      buildServerId: z
        .string()
        .nullable()
        .optional()
        .describe("A server id, or null to build where the app runs."),
      buildFallback: z.boolean().optional(),
    }),
    variables: (a) => ({
      id: a.appId,
      buildServerId: a.buildServerId ?? null,
      buildFallback: a.buildFallback,
    }),
    query: /* GraphQL */ `
      mutation McpSetBuildServer(
        $id: String!
        $buildServerId: String
        $buildFallback: Boolean
      ) {
        setAppBuildServer(
          id: $id
          buildServerId: $buildServerId
          buildFallback: $buildFallback
        ) { ${APP_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "list_build_servers",
    title: "List servers that can build",
    description: "The servers an app may be built on, with their architecture.",
    group: "Apps",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpBuildServers {
        buildServerChoices {
          id
          name
          hostArch
          buildOnly
          buildFallback
          isDeploHost
        }
      }
    `,
  }),
  tool({
    name: "set_app_compose_args",
    title: "Set extra docker compose up arguments",
    description:
      "Flags appended to docker compose up for a compose app, e.g. --force-recreate. Null clears them.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({ appId, value: z.string().nullable() }),
    variables: (a) => ({ id: a.appId, value: a.value }),
    query: /* GraphQL */ `
      mutation McpSetComposeArgs($id: String!, $value: String) {
        setAppComposeUpArgs(id: $id, value: $value) { ${APP_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_app_deploy_hook_enabled",
    title: "Turn an app's deploy hook on or off",
    description:
      "Whether the app's deploy-hook URL accepts calls. The URL itself is never shown over MCP.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({ appId, enabled: z.boolean() }),
    variables: (a) => ({ id: a.appId, value: a.enabled }),
    query: /* GraphQL */ `
      mutation McpSetDeployHook($id: String!, $value: Boolean!) {
        setAppDeployHookEnabled(id: $id, value: $value) { ${APP_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_app_console_enabled",
    title: "Allow or forbid the web console for an app",
    description:
      "Whether members holding open_app_console may open a shell in this app's containers from the dashboard.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({ appId, enabled: z.boolean() }),
    query: /* GraphQL */ `
      mutation McpSetConsoleEnabled($appId: String!, $enabled: Boolean!) {
        setConsoleEnabled(appId: $appId, enabled: $enabled)
      }
    `,
  }),
  tool({
    name: "clear_app_build_cache",
    title: "Clear an app's build cache",
    description:
      "Drop the cached build layers so the next deploy starts from scratch. The fix for a build that keeps reusing a stale step.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({ appId }),
    variables: (a) => ({ id: a.appId }),
    query: /* GraphQL */ `
      mutation McpClearBuildCache($id: String!) {
        clearAppBuildCache(id: $id) {
          id
          slug
        }
      }
    `,
  }),
  tool({
    name: "detect_app_logo",
    title: "Detect an app's logo",
    description:
      "Ask the running app for its favicon and use it as the app's logo.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({ appId }),
    variables: (a) => ({ id: a.appId }),
    query: /* GraphQL */ `
      mutation McpDetectLogo($id: String!) {
        detectAppLogo(id: $id) {
          id
          logo
        }
      }
    `,
  }),
  tool({
    name: "read_app_file",
    title: "Read a file from an app's storage",
    description:
      "Read a text file from the app's persistent files directory (the one mounted into its containers). Binary files are refused.",
    group: "Apps",
    requires: "configure_apps",
    readOnly: true,
    idempotent: true,
    input: z.object({
      appId,
      path: z.string().describe("Path inside the app's files directory."),
    }),
    query: /* GraphQL */ `
      query McpReadAppFile($appId: String!, $path: String!) {
        appStorageFile(appId: $appId, path: $path) {
          path
          state
          text
        }
      }
    `,
  }),
  tool({
    name: "write_app_file",
    title: "Write a file into an app's storage",
    description:
      "Create or overwrite a text file in the app's persistent files directory, e.g. a config the containers read.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    destructive: true,
    input: z.object({
      appId,
      path: z.string(),
      content: z.string(),
    }),
    query: /* GraphQL */ `
      mutation McpWriteAppFile(
        $appId: String!
        $path: String!
        $content: String!
      ) {
        writeAppFile(appId: $appId, path: $path, content: $content)
      }
    `,
  }),
  tool({
    name: "delete_deployments",
    title: "Delete deployment records",
    description:
      "Remove past deployments from an app's history (their kept images go with them). Pass ids, or filters for a bulk delete.",
    group: "Deployments",
    requires: "delete_apps",
    destructive: true,
    input: z.object({
      ids: z.array(z.string()).optional().describe("Specific deployments."),
      appId: z
        .string()
        .optional()
        .describe("Bulk: every deployment of this app."),
      status: z.string().optional().describe("Bulk: only this status."),
    }),
    variables: (a) => {
      if (!a.ids?.length && !a.appId)
        throw new Error("Pass ids, or an appId for a bulk delete.");
      return {
        ids: a.ids ?? [],
        appId: a.appId,
        status: a.status,
        byIds: Boolean(a.ids?.length),
        bulk: !a.ids?.length,
      };
    },
    query: /* GraphQL */ `
      mutation McpDeleteDeployments(
        $ids: [ID!]!
        $appId: ID
        $status: String
        $byIds: Boolean!
        $bulk: Boolean!
      ) {
        deleteDeployments(ids: $ids) @include(if: $byIds)
        deleteAllDeployments(appId: $appId, status: $status) @include(if: $bulk)
      }
    `,
  }),
  tool({
    name: "cancel_all_deployments",
    title: "Cancel every running deployment",
    description:
      "Stop every build or deploy in flight, for one app or for the whole team.",
    group: "Deployments",
    requires: "deploy_apps",
    input: z.object({
      appId: z.string().optional(),
      serverId: z.string().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpCancelAllDeployments($appId: ID, $serverId: ID) {
        cancelAllDeployments(appId: $appId, serverId: $serverId)
      }
    `,
  }),
  tool({
    name: "metrics_history",
    title: "Read metrics history",
    description:
      "The recent CPU, memory, network and disk samples of an app, a database or a server, as the Monitoring page charts them.",
    group: "Monitoring",
    requires: "view_metrics",
    readOnly: true,
    idempotent: true,
    paginate: true,
    input: z.object({
      kind: z.enum(["app", "database", "server"]),
      id: z.string(),
      ...page,
    }),
    variables: (a) => ({
      id: a.id,
      app: a.kind === "app",
      database: a.kind === "database",
      server: a.kind === "server",
    }),
    query: /* GraphQL */ `
      query McpMetricsHistory(
        $id: String!
        $app: Boolean!
        $database: Boolean!
        $server: Boolean!
      ) {
        appMetricsHistory(appId: $id) @include(if: $app) {
          ts
          cpu
          memUsed
          memLimit
          memPct
          netRx
          netTx
          blockRead
          blockWrite
          pids
          running
        }
        databaseMetricsHistory(databaseId: $id) @include(if: $database) {
          ts
          cpu
          memUsed
          memLimit
          memPct
          netRx
          netTx
          blockRead
          blockWrite
          pids
          running
        }
        serverMetricsHistory(serverId: $id) @include(if: $server) {
          ts
          online
          cpu
          memPct
          memUsed
          memTotal
          diskPct
          diskUsed
          diskTotal
          load
          netRx
          netTx
          containers
        }
      }
    `,
  }),
  tool({
    name: "fleet_metrics",
    title: "Read the fleet's live metrics",
    description:
      "One line per server: online, CPU, memory, disk and container count, right now.",
    group: "Monitoring",
    requires: "view_metrics",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpFleetMetrics {
        fleetMetrics {
          serverId
          online
          cpu
          memPct
          diskPct
          containers
          agentVersion
          expectedAgentVersion
          ts
        }
      }
    `,
  }),
  tool({
    name: "set_metrics_retention",
    title: "Turn metrics history on or off",
    description:
      "Whether the team keeps metrics history for its Monitoring charts.",
    group: "Monitoring",
    requires: "manage_monitoring",
    idempotent: true,
    input: z.object({ enabled: z.boolean() }),
    query: /* GraphQL */ `
      mutation McpSetSaveMetrics($enabled: Boolean!) {
        setSaveMetrics(enabled: $enabled) {
          saveMetrics
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Database settings
 * ------------------------------------------------------------------ */

const DATABASE_FIELDS_SETTINGS = /* GraphQL */ `
  id
  name
  type
  version
  status
  serverId
  environmentId
  exposedPublicly
  exposedPort
  customImage
  customCommand
  mounts {
    filePath
    mountPath
  }
`;

const DATABASES_SETTINGS: McpToolDef[] = [
  tool({
    name: "update_database",
    title: "Expose a database or move it to another server",
    description:
      "Publish the database on a host port (exposedPublicly + exposedPort) or move it to another server, which copies its data.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    input: z.object({
      databaseId,
      exposedPublicly: z.boolean(),
      exposedPort: z.number().int().optional(),
      serverId: z.string().optional().describe("Move it to this server."),
    }),
    variables: (a) => ({
      id: a.databaseId,
      input: {
        exposedPublicly: a.exposedPublicly,
        exposedPort: a.exposedPort,
        serverId: a.serverId,
      },
    }),
    query: /* GraphQL */ `
      mutation McpUpdateDatabase($id: String!, $input: UpdateDatabaseInput!) {
        updateDatabase(id: $id, input: $input) { ${DATABASE_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "rename_database",
    title: "Rename a database",
    description: "Change a database's display name. Its host name stays.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    input: z.object({ databaseId, name: z.string() }),
    variables: (a) => ({ id: a.databaseId, name: a.name }),
    query: /* GraphQL */ `
      mutation McpRenameDatabase($id: String!, $name: String!) {
        renameDatabase(id: $id, name: $name) { ${DATABASE_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_database_resources",
    title: "Cap a database's CPU, memory or disk",
    description:
      "Resource limits applied on the next redeploy. Omit a field to leave it unlimited.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    input: z.object({
      databaseId,
      memoryMb: z.number().int().optional(),
      cpuMilli: z.number().int().optional(),
      storageGb: z.number().int().optional(),
      pidsLimit: z.number().int().optional(),
    }),
    variables: (a) => ({
      id: a.databaseId,
      limits: {
        memoryMb: a.memoryMb,
        cpuMilli: a.cpuMilli,
        storageGb: a.storageGb,
        pidsLimit: a.pidsLimit,
      },
    }),
    query: /* GraphQL */ `
      mutation McpSetDatabaseResources(
        $id: String!
        $limits: ResourceLimitsInput!
      ) {
        updateDatabaseResources(id: $id, limits: $limits) { ${DATABASE_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_database_config_files",
    title: "Set a database's config files",
    description:
      "Files Deplo writes and mounts into the database container, e.g. a postgresql.conf. The whole list at once; applied with a reroute.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    destructive: true,
    input: z.object({
      databaseId,
      mounts: z.array(
        z.object({
          filePath: z.string().describe("Name of the file Deplo keeps."),
          mountPath: z.string().describe("Where it appears in the container."),
          content: z.string(),
        }),
      ),
    }),
    variables: (a) => ({ id: a.databaseId, mounts: a.mounts }),
    query: /* GraphQL */ `
      mutation McpSetDatabaseMounts(
        $id: String!
        $mounts: [DatabaseMountInput!]!
      ) {
        setDatabaseMounts(id: $id, mounts: $mounts) { ${DATABASE_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "set_database_image",
    title: "Change a database's engine version or image",
    description:
      "Pin another engine version, or run a custom image/command. Applied on the next redeploy; a major-version jump may need a restore.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    input: z.object({
      databaseId,
      version: z.string().optional(),
      customImage: z.string().optional(),
      customCommand: z.string().optional(),
    }),
    variables: (a) => ({
      id: a.databaseId,
      input: {
        version: a.version,
        customImage: a.customImage,
        customCommand: a.customCommand,
      },
    }),
    query: /* GraphQL */ `
      mutation McpSetDatabaseImage(
        $id: String!
        $input: UpdateDatabaseImageInput!
      ) {
        updateDatabaseImage(id: $id, input: $input) { ${DATABASE_FIELDS_SETTINGS} }
      }
    `,
  }),
  tool({
    name: "move_database",
    title: "Move a database into an environment",
    description:
      "Place a database in a project's environment (or null for the team top level), which decides the network it shares with apps.",
    group: "Databases",
    requires: "configure_databases",
    idempotent: true,
    input: z.object({
      databaseId,
      environmentId: z.string().nullable(),
    }),
    variables: (a) => ({ id: a.databaseId, environmentId: a.environmentId }),
    query: /* GraphQL */ `
      mutation McpMoveDatabase($id: String!, $environmentId: ID) {
        moveDatabaseToEnvironment(id: $id, environmentId: $environmentId)
      }
    `,
  }),
  tool({
    name: "check_host_ports",
    title: "Check whether host ports are free",
    description:
      "Ask a server which of these ports are already in use, before exposing a database or publishing an app port.",
    group: "Databases",
    requires: "create_databases",
    readOnly: true,
    idempotent: true,
    input: z.object({
      serverId,
      ports: z.array(z.number().int()).min(1),
    }),
    query: /* GraphQL */ `
      query McpHostPorts($serverId: ID!, $ports: [Int!]!) {
        hostPortsInUse(serverId: $serverId, ports: $ports) {
          checked
          inUse
          reason
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Backups, cron and previews - the admin half
 * ------------------------------------------------------------------ */

const OPS_ADMIN: McpToolDef[] = [
  tool({
    name: "cancel_backup_run",
    title: "Cancel a running backup",
    description: "Stop a backup that is in progress.",
    group: "Backups",
    requires: "manage_backups",
    input: z.object({ runId: z.string().describe("From list_backup_runs.") }),
    query: /* GraphQL */ `
      mutation McpCancelBackupRun($runId: String!) {
        cancelBackupRun(runId: $runId)
      }
    `,
  }),
  tool({
    name: "delete_backup_run",
    title: "Delete a backup",
    description: "Delete one backup run and the artifact it stored.",
    group: "Backups",
    requires: "delete_backups",
    destructive: true,
    input: z.object({ runId: z.string().describe("From list_backup_runs.") }),
    query: /* GraphQL */ `
      mutation McpDeleteBackupRun($runId: String!) {
        deleteBackupRun(runId: $runId)
      }
    `,
  }),
  tool({
    name: "delete_backup_artifacts",
    title: "Delete every backup of an app or database",
    description: "Remove all stored backups of one app or database at once.",
    group: "Backups",
    requires: "delete_backups",
    destructive: true,
    input: z.object({
      targetId: z.string().describe("The app's or database's id."),
      targetKind: z.enum(["app", "database"]),
    }),
    query: /* GraphQL */ `
      mutation McpDeleteBackupArtifacts(
        $targetId: String!
        $targetKind: BackupTargetKind!
      ) {
        deleteBackupArtifacts(targetId: $targetId, targetKind: $targetKind)
      }
    `,
  }),
  tool({
    name: "list_backup_destination_options",
    title: "List where a backup can go",
    description:
      "The destinations a new backup schedule may pick, with whether each is encrypted and healthy.",
    group: "Backups",
    requires: "manage_backups",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpDestinationOptions {
        backupDestinationOptions {
          id
          name
          kind
          where
          status
          encrypted
          recoveryKeySavedAt
        }
      }
    `,
  }),
  tool({
    name: "update_cron_job",
    title: "Edit a cron job",
    description:
      "Change any field of a scheduled command: schedule, command, container, timezone, retries, timeout.",
    group: "Cron",
    requires: "manage_crons",
    idempotent: true,
    input: z.object({
      id: z.string().describe("From list_cron_jobs."),
      name: z.string().optional(),
      description: z.string().optional(),
      schedule: z.string().optional().describe("5-field cron."),
      command: z.string().optional(),
      service: z.string().optional().describe("Container it runs in."),
      timezone: z.string().optional(),
      enabled: z.boolean().optional(),
      timeoutSeconds: z.number().int().optional(),
      maxAttempts: z.number().int().optional(),
      keepRuns: z.number().int().optional(),
      overlap: z.string().optional().describe("skip | queue | allow."),
      shell: z.string().optional(),
      user: z.string().optional(),
      workdir: z.string().optional(),
    }),
    variables: ({ id, ...input }) => ({ id, input }),
    query: /* GraphQL */ `
      mutation McpUpdateCronJob($id: ID!, $input: CronJobInput!) {
        updateCronJob(id: $id, input: $input) {
          id
          name
          schedule
          command
          service
          enabled
          nextRunAt
        }
      }
    `,
  }),
  tool({
    name: "set_cron_enabled",
    title: "Turn cron on or off for an app or database",
    description:
      "The master switch over every cron job of one app or database.",
    group: "Cron",
    requires: "manage_crons",
    idempotent: true,
    input: z.object({
      targetId: z.string().describe("The app's or database's id."),
      targetKind: z.enum(["app", "database"]),
      enabled: z.boolean(),
    }),
    query: /* GraphQL */ `
      mutation McpSetCronEnabled(
        $targetId: ID!
        $targetKind: String!
        $enabled: Boolean!
      ) {
        setCronEnabled(
          targetId: $targetId
          targetKind: $targetKind
          enabled: $enabled
        )
      }
    `,
  }),
  tool({
    name: "list_cron_runs",
    title: "List a cron job's runs",
    description:
      "Past and running executions of one job, with exit code, output and errors, newest first.",
    group: "Cron",
    requires: "manage_crons",
    readOnly: true,
    idempotent: true,
    input: z.object({
      jobId: z.string().describe("From list_cron_jobs."),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    query: /* GraphQL */ `
      query McpCronRuns($jobId: ID!, $limit: Int) {
        cronRuns(jobId: $jobId, limit: $limit) {
          id
          status
          trigger
          attempt
          maxAttempts
          exitCode
          scheduledFor
          startedAt
          finishedAt
          error
          stdout
          stderr
        }
      }
    `,
  }),
  tool({
    name: "cancel_cron_run",
    title: "Cancel a running cron job",
    description: "Stop one execution that is still running.",
    group: "Cron",
    requires: "manage_crons",
    input: z.object({
      id: z.string().describe("A run id, from list_cron_runs."),
    }),
    query: /* GraphQL */ `
      mutation McpCancelCronRun($id: ID!) {
        cancelCronRun(id: $id)
      }
    `,
  }),
  tool({
    name: "list_open_pull_requests",
    title: "List an app's open pull requests",
    description:
      "The open pull requests of the app's repository, the ones deploy_pull_request can preview.",
    group: "Previews",
    requires: "manage_previews",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      query McpOpenPullRequests($appId: ID!) {
        openPullRequests(appId: $appId) {
          number
          title
          headRef
          baseRef
          authorLogin
          draft
          fromFork
          htmlUrl
          updatedAt
        }
      }
    `,
  }),
  tool({
    name: "set_app_preview_settings",
    title: "Configure pull request previews for an app",
    description:
      "Turn previews on or off and tune them: base domain, auto-deploy, drafts, fork policy, TTL, max active, comment on the PR.",
    group: "Previews",
    requires: "manage_previews",
    idempotent: true,
    input: z.object({
      appId,
      enabled: z.boolean().optional(),
      autoDeploy: z.boolean().optional(),
      buildDrafts: z.boolean().optional(),
      comment: z.boolean().optional(),
      baseDomain: z.string().optional(),
      https: z.boolean().optional(),
      forkPolicy: z.string().optional().describe("never | approve | always."),
      requiredLabels: z.string().optional(),
      maxActive: z.number().int().optional(),
      ttlDays: z.number().int().optional(),
      port: z.number().int().optional(),
      serverId: z.string().optional(),
    }),
    variables: ({ appId: id, ...input }) => ({ appId: id, input }),
    query: /* GraphQL */ `
      mutation McpSetPreviewSettings(
        $appId: ID!
        $input: AppPreviewSettingsInput!
      ) {
        setAppPreviewSettings(appId: $appId, input: $input)
      }
    `,
  }),
  tool({
    name: "approve_preview",
    title: "Approve a preview from a fork",
    description:
      "Let a pull request from a fork be deployed as a preview, once its code has been looked at.",
    group: "Previews",
    requires: "manage_previews",
    input: z.object({ id: z.string().describe("From list_previews.") }),
    query: /* GraphQL */ `
      mutation McpApprovePreview($id: ID!) {
        approvePreview(id: $id) {
          id
          prNumber
          approved
          status
        }
      }
    `,
  }),
  tool({
    name: "redeploy_preview",
    title: "Redeploy a preview",
    description: "Rebuild and redeploy one pull request preview.",
    group: "Previews",
    requires: "manage_previews",
    input: z.object({ id: z.string().describe("From list_previews.") }),
    query: /* GraphQL */ `
      mutation McpRedeployPreview($id: ID!) {
        redeployPreview(id: $id) {
          id
          prNumber
          status
          url
        }
      }
    `,
  }),
  tool({
    name: "list_preview_env",
    title: "List an app's preview-only variables",
    description:
      "Variables injected only into pull request previews. Values are never shown.",
    group: "Previews",
    requires: "manage_env",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId }),
    query: /* GraphQL */ `
      query McpPreviewEnv($appId: ID!) {
        previewEnvVars(appId: $appId) {
          key
          type
          updatedAt
        }
      }
    `,
  }),
  tool({
    name: "set_preview_env_var",
    title: "Set or delete a preview-only variable",
    description:
      "Set one variable that only previews receive, or delete it by passing no value.",
    group: "Previews",
    requires: "manage_env",
    idempotent: true,
    input: z.object({
      appId,
      key: z.string(),
      value: z.string().optional().describe("Omit to delete the key."),
      secret: z.boolean().optional(),
    }),
    variables: (a) => ({
      appId: a.appId,
      key: a.key,
      value: a.value ?? "",
      secret: a.secret,
      set: a.value !== undefined,
      remove: a.value === undefined,
    }),
    query: /* GraphQL */ `
      mutation McpSetPreviewEnv(
        $appId: ID!
        $key: String!
        $value: String!
        $secret: Boolean
        $set: Boolean!
        $remove: Boolean!
      ) {
        setPreviewEnvVar(
          appId: $appId
          key: $key
          value: $value
          secret: $secret
        ) @include(if: $set)
        deletePreviewEnvVar(appId: $appId, key: $key) @include(if: $remove)
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Fleet administration (instance admin)
 * ------------------------------------------------------------------ */

const SERVER_ROW = /* GraphQL */ `
  id
  name
  host
  role
  type
  status
  allTeams
  buildFallback
  deployConcurrency
  agentVersion
  isDeploHost
`;

const FLEET: McpToolDef[] = [
  tool({
    name: "add_server",
    title: "Register a new server",
    description:
      "Add a machine to the fleet. Returns the one-line install command that has to be run on it once; it carries an enrolment token, so hand it to the person who owns the machine rather than repeating it.",
    group: "Servers",
    requires: "instanceAdmin",
    input: z.object({
      name: z.string(),
      host: z.string().describe("IP or hostname Deplo dials."),
      allTeams: z.boolean().optional().describe("Usable by every team."),
      teamIds: z.array(z.string()).optional(),
      buildOnly: z.boolean().optional(),
      storageOnly: z.boolean().optional(),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpAddServer($input: AddServerInput!) {
        addServer(input: $input) {
          server { ${SERVER_ROW} }
          installCommand
        }
      }
    `,
  }),
  tool({
    name: "remove_server",
    title: "Remove a server",
    description:
      "Take a server out of the fleet. Refused while apps still run on it; the agent is uninstalled by the reaper afterwards.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ serverId }),
    variables: (a) => ({ id: a.serverId }),
    query: /* GraphQL */ `
      mutation McpRemoveServer($id: String!) {
        removeServer(id: $id) {
          warning
        }
      }
    `,
  }),
  tool({
    name: "update_server",
    title: "Change a server's address, role, teams or limits",
    description:
      "Any of: the address Deplo dials, its role, which teams may use it, build fallback, deploy concurrency, timezone.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({
      serverId,
      address: z.string().optional(),
      agentPort: z.number().int().optional(),
      role: z.string().optional(),
      allTeams: z.boolean().optional(),
      teamIds: z.array(z.string()).optional(),
      buildFallback: z.boolean().optional(),
      deployConcurrency: z.number().int().optional(),
      timezone: z.string().optional().describe("IANA zone."),
    }),
    variables: (a) => ({
      id: a.serverId,
      address: a.address ?? "",
      agentPort: a.agentPort,
      role: a.role ?? "",
      teams: {
        serverId: a.serverId,
        allTeams: a.allTeams ?? false,
        teamIds: a.teamIds,
      },
      buildFallback: a.buildFallback,
      concurrency: a.deployConcurrency ?? 1,
      timezone: a.timezone ?? "",
      setAddress: a.address !== undefined,
      setRole: a.role !== undefined,
      setTeams: a.allTeams !== undefined || a.teamIds !== undefined,
      setFallback: a.buildFallback !== undefined,
      setConcurrency: a.deployConcurrency !== undefined,
      setTimezone: a.timezone !== undefined,
    }),
    query: /* GraphQL */ `
      mutation McpUpdateServer(
        $id: String!
        $address: String!
        $agentPort: Int
        $role: String!
        $teams: SetServerTeamsInput!
        $buildFallback: Boolean
        $concurrency: Int!
        $timezone: String!
        $setAddress: Boolean!
        $setRole: Boolean!
        $setTeams: Boolean!
        $setFallback: Boolean!
        $setConcurrency: Boolean!
        $setTimezone: Boolean!
      ) {
        updateServerAddress(id: $id, address: $address, agentPort: $agentPort)
          @include(if: $setAddress)
        setServerRole(id: $id, role: $role) @include(if: $setRole) {
          id
          role
        }
        setServerTeams(input: $teams) @include(if: $setTeams) {
          id
          allTeams
        }
        setServerBuildFallback(id: $id, buildFallback: $buildFallback)
          @include(if: $setFallback) {
          id
          buildFallback
        }
        setServerDeployConcurrency(id: $id, concurrency: $concurrency)
          @include(if: $setConcurrency) {
          id
          deployConcurrency
        }
        setServerTimezone(id: $id, timezone: $timezone)
          @include(if: $setTimezone) {
          timezone
        }
      }
    `,
  }),
  tool({
    name: "get_server_host_info",
    title: "Read a server's host facts",
    description:
      "Ask the server about itself: OS, kernel, CPU, memory, disk, Docker version, timezone and uptime.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ serverId }),
    variables: (a) => ({ id: a.serverId }),
    query: /* GraphQL */ `
      mutation McpHostInfo($id: String!) {
        checkServerHostInfo(id: $id) {
          osPretty
          kernel
          arch
          cpuModel
          cpuCores
          memTotalBytes
          diskTotalBytes
          diskUsedBytes
          dockerVersion
          timezone
          uptimeSec
        }
      }
    `,
  }),
  tool({
    name: "check_agent_updates",
    title: "Check for server agent updates",
    description:
      "Look up the newest agent release and compare it with what every server runs.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      mutation McpCheckAgentUpdates {
        checkAgentUpdates
      }
    `,
  }),
  tool({
    name: "uninstall_server_agent",
    title: "Uninstall a server's agent",
    description:
      "Remove the Deplo agent from a machine that has already been taken out of service.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ serverId }),
    variables: (a) => ({ id: a.serverId }),
    query: /* GraphQL */ `
      mutation McpUninstallAgent($id: String!) {
        uninstallServerAgent(id: $id) {
          removed
          warning
          error
        }
      }
    `,
  }),
  tool({
    name: "add_server_certificate",
    title: "Add a custom TLS certificate to a server",
    description:
      "Install your own certificate and key on a server's proxy, for a domain Let's Encrypt cannot issue.",
    group: "Servers",
    requires: "instanceAdmin",
    input: z.object({
      serverId,
      certificate: z.string().describe("PEM chain."),
      privateKey: z.string().describe("PEM key."),
    }),
    variables: (a) => ({
      id: a.serverId,
      input: { certificate: a.certificate, privateKey: a.privateKey },
    }),
    query: /* GraphQL */ `
      mutation McpAddCertificate(
        $id: String!
        $input: ServerCertificateInput!
      ) {
        addServerCertificate(id: $id, input: $input) {
          id
          subject
          domains
          notAfter
          expiresInDays
        }
      }
    `,
  }),
  tool({
    name: "remove_server_certificate",
    title: "Remove a custom TLS certificate",
    description: "Drop a certificate that was added by hand to a server.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ serverId, certificateId: z.string() }),
    variables: (a) => ({ id: a.serverId, certificateId: a.certificateId }),
    query: /* GraphQL */ `
      mutation McpRemoveCertificate($id: String!, $certificateId: String!) {
        removeServerCertificate(id: $id, certificateId: $certificateId) {
          id
          subject
        }
      }
    `,
  }),
  tool({
    name: "set_certificate_email",
    title: "Set the Let's Encrypt account email",
    description:
      "The email every server's certificate account is registered with.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ email: z.string() }),
    query: /* GraphQL */ `
      mutation McpSetCertificateEmail($email: String!) {
        setCertificateEmail(email: $email) {
          serverName
          email
          unavailable
        }
      }
    `,
  }),
  tool({
    name: "get_docker_cleanup_policy",
    title: "Read the Docker cleanup policy",
    description:
      "Whether automatic cleanup runs, on what schedule, which scopes, and which servers are excluded.",
    group: "Servers",
    requires: "instanceAdmin",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpCleanupPolicy {
        dockerCleanupPolicy {
          enabled
          schedule
          scopes
          keepImagesPerApp
          minAgeHours
          excludedServerIds
          updatedAt
        }
      }
    `,
  }),
  tool({
    name: "update_docker_cleanup_policy",
    title: "Change the Docker cleanup policy",
    description:
      "Set the whole policy at once: on/off, cron schedule, scopes, images kept per app, minimum age for caches, excluded servers.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({
      enabled: z.boolean(),
      schedule: z.string().describe("5-field cron."),
      scopes: z.array(
        z.enum([
          "unused_app_images",
          "dangling_images",
          "build_cache",
          "orphan_buildkit_cache",
          "leftover_networks",
          "leftover_app_files",
        ]),
      ),
      keepImagesPerApp: z.number().int().min(1),
      minAgeHours: z.number().int().min(0),
      excludedServerIds: z.array(z.string()).optional(),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpUpdateCleanupPolicy($input: UpdateDockerCleanupPolicyInput!) {
        updateDockerCleanupPolicy(input: $input) {
          enabled
          schedule
          scopes
          keepImagesPerApp
          minAgeHours
          excludedServerIds
        }
      }
    `,
  }),
  tool({
    name: "set_server_cleanup_excluded",
    title: "Exclude a server from Docker cleanup",
    description: "Skip (or include again) one server in the cleanup runs.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ serverId, excluded: z.boolean() }),
    query: /* GraphQL */ `
      mutation McpSetCleanupExcluded($serverId: String!, $excluded: Boolean!) {
        setServerCleanupExcluded(serverId: $serverId, excluded: $excluded) {
          excludedServerIds
        }
      }
    `,
  }),
];

/* ------------------------------------------------------------------ *
 * Destinations, notifications, git, the panel itself
 * ------------------------------------------------------------------ */

const DESTINATION_FIELDS = /* GraphQL */ `
  id
  name
  kind
  where
  status
  encrypted
  serverName
  bucket
  endpoint
  region
  path
  lastTestAt
  lastTestError
`;

const INTEGRATIONS: McpToolDef[] = [
  tool({
    name: "create_destination",
    title: "Add a backup destination",
    description:
      "Where backups are stored: an S3-compatible bucket (with credentials) or a directory on one of the fleet's servers.",
    group: "Backups",
    requires: "manage_backup_destinations",
    input: z.object({
      name: z.string(),
      kind: z.enum(["s3", "server"]),
      serverId: z.string().optional().describe("For kind server."),
      path: z.string().optional().describe("For kind server."),
      provider: z
        .enum([
          "AWS",
          "BACKBLAZE_B2",
          "CLOUDFLARE_R2",
          "DIGITALOCEAN",
          "MINIO",
          "OTHER",
          "WASABI",
        ])
        .optional(),
      endpoint: z.string().optional(),
      region: z.string().optional(),
      bucket: z.string().optional(),
      accessKey: z.string().optional(),
      secretKey: z.string().optional(),
      s3ExtraArgs: z.string().optional(),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpCreateDestination($input: CreateDestinationInput!) {
        createDestination(input: $input) { ${DESTINATION_FIELDS} }
      }
    `,
  }),
  tool({
    name: "test_destination",
    title: "Test a backup destination",
    description:
      "Write and read a probe object to prove the destination works.",
    group: "Backups",
    requires: "manage_backup_destinations",
    idempotent: true,
    input: z.object({ id: z.string().describe("From list_destinations.") }),
    query: /* GraphQL */ `
      mutation McpTestDestination($id: String!) {
        testDestination(id: $id) {
          destination { ${DESTINATION_FIELDS} }
        }
      }
    `,
  }),
  tool({
    name: "delete_destination",
    title: "Delete a backup destination",
    description:
      "Remove a destination. Refused while schedules point at it; deleteArtifacts also removes the backups it holds.",
    group: "Backups",
    requires: "manage_backup_destinations",
    destructive: true,
    input: z.object({
      id: z.string().describe("From list_destinations."),
      deleteArtifacts: z.boolean().optional(),
    }),
    query: /* GraphQL */ `
      mutation McpDeleteDestination($id: String!, $deleteArtifacts: Boolean) {
        deleteDestination(id: $id, deleteArtifacts: $deleteArtifacts)
      }
    `,
  }),
  tool({
    name: "list_notification_channels",
    title: "List notification channels",
    description:
      "Where this team is told about deploys and alerts: email, Slack, Discord, Telegram, webhooks. Credentials are masked.",
    group: "Notifications",
    requires: "manage_notifications",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpNotificationChannels {
        notificationChannels
      }
    `,
  }),
  tool({
    name: "save_notification_channel",
    title: "Create or edit a notification channel",
    description:
      "Create a channel from its settings object (type, name, target, which events), or edit one by passing its id.",
    group: "Notifications",
    requires: "manage_notifications",
    input: z.object({
      id: z.string().optional(),
      input: z
        .record(z.string(), z.unknown())
        .describe(
          "The channel's settings, as list_notification_channels shows them.",
        ),
    }),
    query: /* GraphQL */ `
      mutation McpSaveNotificationChannel($id: ID, $input: JSON!) {
        saveNotificationChannel(id: $id, input: $input)
      }
    `,
  }),
  tool({
    name: "test_notification_channel",
    title: "Send a test notification",
    description: "Send a test message through one channel.",
    group: "Notifications",
    requires: "manage_notifications",
    idempotent: true,
    input: z.object({ id: z.string() }),
    query: /* GraphQL */ `
      mutation McpTestNotificationChannel($id: ID!) {
        testNotificationChannel(id: $id)
      }
    `,
  }),
  tool({
    name: "delete_notification_channel",
    title: "Delete a notification channel",
    description:
      "Remove a notification channel, so nothing is sent through it any more.",
    group: "Notifications",
    requires: "manage_notifications",
    destructive: true,
    input: z.object({ id: z.string() }),
    query: /* GraphQL */ `
      mutation McpDeleteNotificationChannel($id: ID!) {
        deleteNotificationChannel(id: $id)
      }
    `,
  }),
  tool({
    name: "list_git_providers",
    title: "List the git providers Deplo can connect",
    description:
      "GitHub, GitLab, Bitbucket, Gitea: what each needs (token scopes, base URL) to be connected.",
    group: "Git",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpGitProviders {
        gitProviders {
          id
          label
          defaultBaseUrl
          defaultUsername
          hasApi
          tokenScopes
          tokenHelpUrl
        }
      }
    `,
  }),
  tool({
    name: "connect_git_provider",
    title: "Connect a git provider with a token",
    description:
      "Connect GitLab, Bitbucket or Gitea (GitHub uses its own app flow in the dashboard) with a personal access token.",
    group: "Git",
    requires: "manage_git",
    input: z.object({
      provider: z.string().describe("From list_git_providers."),
      label: z.string(),
      baseUrl: z.string(),
      token: z.string(),
      username: z.string().optional(),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpConnectGit($input: ConnectGitProviderInput!) {
        connectGitProvider(input: $input) {
          id
          provider
          label
          baseUrl
          health
        }
      }
    `,
  }),
  tool({
    name: "update_git_connection",
    title: "Rotate a git connection's token or rename it",
    description: "Change the label, the token or the username of a connection.",
    group: "Git",
    requires: "manage_git",
    idempotent: true,
    input: z.object({
      id: z.string().describe("From list_git_sources."),
      label: z.string().optional(),
      token: z.string().optional(),
      username: z.string().optional(),
    }),
    variables: ({ id, ...input }) => ({ id, input }),
    query: /* GraphQL */ `
      mutation McpUpdateGit($id: String!, $input: UpdateGitConnectionInput!) {
        updateGitConnection(id: $id, input: $input) {
          id
          label
          health
        }
      }
    `,
  }),
  tool({
    name: "test_git_connection",
    title: "Test a git connection",
    description: "Check that a connection's token still works.",
    group: "Git",
    requires: "manage_git",
    idempotent: true,
    input: z.object({ id: z.string().describe("From list_git_sources.") }),
    query: /* GraphQL */ `
      mutation McpTestGit($id: String!) {
        testGitConnection(id: $id) {
          id
          health
          healthError
          lastCheckedAt
        }
      }
    `,
  }),
  tool({
    name: "remove_git_connection",
    title: "Disconnect a git provider",
    description:
      "Remove a connection. Apps deploying through it keep their code but lose automatic deploys.",
    group: "Git",
    requires: "manage_git",
    destructive: true,
    input: z.object({ id: z.string().describe("From list_git_sources.") }),
    query: /* GraphQL */ `
      mutation McpRemoveGit($id: String!) {
        removeGitConnection(id: $id)
      }
    `,
  }),
  tool({
    name: "get_instance",
    title: "Read this Deplo's own settings",
    description:
      "The panel's address, version, log retention, and whether an update is available.",
    group: "Instance",
    requires: "instanceAdmin",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpInstance {
        instanceSettings {
          version
          panelUrl
          panelUrlSource
          storedPanelUrl
          panelFallbackUrl
          logMaxDays
          deploHostName
          deploHostIp
        }
        updateInfo {
          current
          latest
          updateAvailable
          publishedAt
          url
          checkedAt
          error
        }
      }
    `,
  }),
  tool({
    name: "check_for_updates",
    title: "Check for a Deplo update",
    description: "Look up the newest Deplo release right now.",
    group: "Instance",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      mutation McpCheckForUpdates {
        checkForUpdates {
          current
          latest
          updateAvailable
          publishedAt
          url
        }
      }
    `,
  }),
  tool({
    name: "read_changelog",
    title: "Read Deplo's changelog",
    description: "The recent releases and what changed in each.",
    group: "Instance",
    requires: "instanceAdmin",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpChangelog {
        deploChangelog {
          error
          releases {
            tag
            name
            publishedAt
            prerelease
            body
          }
        }
      }
    `,
  }),
  tool({
    name: "set_panel_url",
    title: "Set the panel's public address",
    description:
      "The address Deplo publishes for itself (webhooks, OAuth, agents). Null goes back to the detected one.",
    group: "Instance",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ url: z.string().nullable() }),
    query: /* GraphQL */ `
      mutation McpSetPanelUrl($url: String) {
        setPanelUrl(url: $url) {
          panelUrl
          panelUrlSource
        }
      }
    `,
  }),
  tool({
    name: "set_panel_https",
    title: "Turn HTTPS for the panel on or off",
    description:
      "Serve the panel over HTTPS through the Deplo host's proxy, with a certificate for the panel's domain.",
    group: "Instance",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ enabled: z.boolean() }),
    query: /* GraphQL */ `
      mutation McpSetPanelHttps($enabled: Boolean!) {
        setPanelHttps(enabled: $enabled) {
          enabled
          domain
          certificateTrusted
          unavailable
        }
      }
    `,
  }),
  tool({
    name: "set_log_retention",
    title: "Set how many days of logs are kept",
    description: "Log retention for every app and database on this Deplo.",
    group: "Instance",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ days: z.number().int().min(1) }),
    query: /* GraphQL */ `
      mutation McpSetLogMaxDays($days: Int!) {
        setLogMaxDays(days: $days) {
          logMaxDays
        }
      }
    `,
  }),
  tool({
    name: "restart_panel",
    title: "Restart the Deplo panel",
    description:
      "Restart the control plane itself, on the server that runs it. Every dashboard session is interrupted for a moment.",
    group: "Instance",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ serverId: serverId.describe("The Deplo host's id.") }),
    variables: (a) => ({ id: a.serverId }),
    query: /* GraphQL */ `
      mutation McpRestartPanel($id: String!) {
        restartDeploPanel(id: $id)
      }
    `,
  }),
];

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
  ...STRUCTURE,
  ...TEAM_ADMIN,
  ...APPS_SETTINGS,
  ...DATABASES_SETTINGS,
  ...OPS_ADMIN,
  ...FLEET,
  ...INTEGRATIONS,
  ...ESCAPE_HATCH,
];

/** Group order for the settings table, derived so the two cannot drift. */
export const MCP_TOOL_GROUPS: string[] = [
  ...new Set(MCP_TOOLS.map((t) => t.group)),
];
