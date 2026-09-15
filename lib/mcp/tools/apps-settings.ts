import * as z from "zod";
import { appId, CRON_KIND, tool, type McpToolDef } from "./tool-def";

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

export const APPS_SETTINGS: McpToolDef[] = [
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
];
