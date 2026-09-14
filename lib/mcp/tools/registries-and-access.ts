import * as z from "zod";
import { appId, tool, type McpToolDef } from "./tool-def";

export const REGISTRIES_AND_ACCESS: McpToolDef[] = [
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
