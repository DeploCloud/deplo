import * as z from "zod";
import { appId, tool, type McpToolDef } from "./tool-def";
import { APP_FIELDS } from "./apps-read";

export const APPS_CONFIG: McpToolDef[] = [
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
    name: "update_app_compose",
    title: "Edit an app's compose file",
    description:
      "Replace a compose app's YAML with the whole edited file: read it with get_app, change it, send it back. Same rules as the editor; deploy_app applies it.",
    group: "Apps",
    requires: "configure_apps",
    idempotent: true,
    input: z.object({
      appId,
      compose: z.string().describe("The complete compose YAML, not a diff."),
    }),
    query: /* GraphQL */ `
      mutation McpUpdateAppCompose($id: String!, $input: UpdateSourceInput!) {
        updateAppSource(id: $id, input: $input) { ${APP_FIELDS} }
      }
    `,
    variables: (a) => ({
      id: a.appId,
      input: { source: "COMPOSE", compose: a.compose },
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
