import * as z from "zod";
import { appId, tool, type McpToolDef } from "./tool-def";

export const TEAM: McpToolDef[] = [
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

const ROLE_SCOPE = z
  .object({
    projectIds: z.array(z.string()).optional(),
    environmentIds: z.array(z.string()).optional(),
    folderIds: z.array(z.string()).optional(),
    appIds: z.array(z.string()).optional(),
  })
  .optional()
  .describe("Limit the role to part of the team. Omit for the whole team.");

export const TEAM_ADMIN: McpToolDef[] = [
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
