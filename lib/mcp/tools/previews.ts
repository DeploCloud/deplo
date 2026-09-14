import * as z from "zod";
import { appId, tool, type McpToolDef } from "./tool-def";

export const PREVIEWS: McpToolDef[] = [
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

export const PREVIEWS_ADMIN: McpToolDef[] = [
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
