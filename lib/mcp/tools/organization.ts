import * as z from "zod";
import { appId, tool, type McpToolDef } from "./tool-def";

export const ORGANIZATION: McpToolDef[] = [
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

export const STRUCTURE: McpToolDef[] = [
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
];
