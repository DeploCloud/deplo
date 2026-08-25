import { builder } from "../builder";
import { RoleEnum, CapabilityEnum } from "./enums";
import {
  listRoles,
  createRole,
  updateRole,
  resetRole,
  deleteRole,
  type TeamRoleDTO,
} from "@/lib/data/roles";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

/** What a scoped role reaches. Absent on a role that reaches the whole team. */
const RoleScopeRef = builder
  .objectRef<{
    projectIds: string[];
    environmentIds: string[];
    folderIds: string[];
    appIds: string[];
  }>("RoleScope")
  .implement({
    description:
      "The projects, folders and apps a role reaches. A folder brings its whole subtree. All three empty means it reaches nothing, which is what a scope whose nodes were all deleted becomes.",
    fields: (t) => ({
      projectIds: t.exposeStringList("projectIds"),
      environmentIds: t.exposeStringList("environmentIds"),
      folderIds: t.exposeStringList("folderIds"),
      appIds: t.exposeStringList("appIds"),
    }),
  });

export const TeamRoleRef = builder
  .objectRef<TeamRoleDTO>("TeamRole")
  .implement({
    description:
      "A named capability set members of the active team can be assigned. Three defaults (owner/member/viewer) plus any number the team authors itself.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      description: t.exposeString("description", { nullable: true }),
      builtinKey: t.field({
        type: RoleEnum,
        nullable: true,
        description:
          "Set for one of the three default roles; null for a role the team created.",
        resolve: (r) => r.builtinKey,
      }),
      capabilities: t.field({
        type: [CapabilityEnum],
        description:
          "Exactly what a member holding this role can do. `view` is always included.",
        resolve: (r) => r.capabilities,
      }),
      requireTwoFactor: t.exposeBoolean("requireTwoFactor", {
        description:
          "Holders of this role must have two-factor authentication; without it they resolve no capabilities at all, over the UI and the API alike.",
      }),
      memberCount: t.exposeInt("memberCount"),
      modified: t.exposeBoolean("modified", {
        description:
          "A default role edited away from what deplo ships — it can be reset.",
      }),
      locked: t.exposeBoolean("locked", {
        description:
          "The Owner default: always full access, not editable, so a team can never edit its way out of administering itself.",
      }),
      scope: t.field({
        type: RoleScopeRef,
        nullable: true,
        description:
          "Where in the team this role reaches. Null means the whole of it, which is every role until one is limited. A scoped role also loses every capability that only means something team-wide.",
        resolve: (r) => r.scope,
      }),
      createdAt: t.exposeString("createdAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const RoleScopeInputType = builder.inputType("RoleScopeInput", {
  description:
    "The nodes a role reaches. Ticking a project, one of its environments or a folder covers everything inside it, now and later; omit the field entirely for the whole team.",
  fields: (t) => ({
    projectIds: t.stringList({ required: false }),
    /** One environment of a project - the finest cut inside one. */
    environmentIds: t.stringList({ required: false }),
    folderIds: t.stringList({ required: false }),
    appIds: t.stringList({ required: false }),
  }),
});

const CreateRoleInputType = builder.inputType("CreateRoleInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    description: t.string({ required: false }),
    // Omitted / empty ⇒ a view-only role. `view` is added server-side either way.
    capabilities: t.field({ type: [CapabilityEnum], required: false }),
    requireTwoFactor: t.boolean({ required: false }),
    scope: t.field({ type: RoleScopeInputType, required: false }),
  }),
});

const UpdateRoleInputType = builder.inputType("UpdateRoleInput", {
  fields: (t) => ({
    id: t.string({ required: true }),
    name: t.string({ required: true }),
    description: t.string({ required: false }),
    capabilities: t.field({ type: [CapabilityEnum], required: false }),
    requireTwoFactor: t.boolean({ required: false }),
    // Absent leaves the reach alone; present replaces it, and `{}` with no ids
    // is a role that reaches nothing rather than one that reaches everything.
    // Clearing a scope is `clearScope`, so "absent" can never mean "widen".
    scope: t.field({ type: RoleScopeInputType, required: false }),
    clearScope: t.boolean({ required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  teamRoles: t.field({
    type: [TeamRoleRef],
    authScopes: { loggedIn: true },
    description:
      "Every role of the active team — defaults first, then the team's own.",
    resolve: () => listRoles(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createRole: t.field({
    type: TeamRoleRef,
    authScopes: { capability: "manage_roles" },
    description: "Create a custom role for the active team.",
    args: { input: t.arg({ type: CreateRoleInputType, required: true }) },
    resolve: (_r, { input }) =>
      createRole({
        name: input.name,
        description: input.description ?? null,
        capabilities: (input.capabilities ?? undefined) as never,
        requireTwoFactor: input.requireTwoFactor ?? false,
        scope: input.scope
          ? {
              projectIds: input.scope.projectIds ?? undefined,
              environmentIds: input.scope.environmentIds ?? undefined,
              folderIds: input.scope.folderIds ?? undefined,
              appIds: input.scope.appIds ?? undefined,
            }
          : null,
      }),
  }),
  updateRole: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_roles" },
    description:
      "Rename and/or re-scope a role. Every member holding it gets the new capability set immediately. Returns true.",
    args: { input: t.arg({ type: UpdateRoleInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await updateRole({
        id: input.id,
        name: input.name,
        description: input.description ?? null,
        capabilities: (input.capabilities ?? undefined) as never,
        requireTwoFactor: input.requireTwoFactor ?? false,
        // Three states, not two: a scope to set, an explicit clear, or absent (leave the
        // reach alone). Absent must never mean "widen", or every client that predates this
        // field would quietly unlimit every role it renames.
        scope: input.clearScope
          ? null
          : input.scope
            ? {
                projectIds: input.scope.projectIds ?? undefined,
                environmentIds: input.scope.environmentIds ?? undefined,
                folderIds: input.scope.folderIds ?? undefined,
                appIds: input.scope.appIds ?? undefined,
              }
            : undefined,
      });
      return true;
    },
  }),
  resetRole: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_roles" },
    description:
      "Restore a default role to exactly what deplo ships, for its members too. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await resetRole(id);
      return true;
    },
  }),
  deleteRole: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_roles" },
    description:
      "Delete a custom role. Refuses while any member still holds it. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteRole(id);
      return true;
    },
  }),
}));
