import * as z from "zod";
import { appId, tool, type McpToolDef } from "./tool-def";
import { APP_FIELDS, DEPLOYMENT_FIELDS } from "./apps-read";

export const APPS_OPS: McpToolDef[] = [
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
