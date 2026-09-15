import * as z from "zod";
import { appId, tool, type McpToolDef } from "./tool-def";

export const ENV: McpToolDef[] = [
  tool({
    name: "list_env",
    title: "List environment variables",
    description:
      "An app's variables. Secret values are masked and there is no way to reveal them over MCP - read the key names, not the values.",
    group: "Environment",
    // manage_env, not view: without it listEnv answers an empty list, which reads as "no variables".
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

export const SHARED_ENV: McpToolDef[] = [
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

export const APP_SHARED_ENV: McpToolDef[] = [
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
