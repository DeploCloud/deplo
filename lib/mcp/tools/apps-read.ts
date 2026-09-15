import * as z from "zod";
import { appId, page, tool, type McpToolDef } from "./tool-def";

export const APP_FIELDS = /* GraphQL */ `
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

export const DEPLOYMENT_FIELDS = /* GraphQL */ `
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

export const APPS_READ: McpToolDef[] = [
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
