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
      memberCount: t.exposeInt("memberCount"),
      modified: t.exposeBoolean("modified", {
        description:
          "A default role edited away from what deplo ships — it can be reset.",
      }),
      locked: t.exposeBoolean("locked", {
        description:
          "The Owner default: always full access, not editable, so a team can never edit its way out of administering itself.",
      }),
      createdAt: t.exposeString("createdAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const CreateRoleInputType = builder.inputType("CreateRoleInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    description: t.string({ required: false }),
    // Omitted / empty ⇒ a view-only role. `view` is added server-side either way.
    capabilities: t.field({ type: [CapabilityEnum], required: false }),
  }),
});

const UpdateRoleInputType = builder.inputType("UpdateRoleInput", {
  fields: (t) => ({
    id: t.string({ required: true }),
    name: t.string({ required: true }),
    description: t.string({ required: false }),
    capabilities: t.field({ type: [CapabilityEnum], required: false }),
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
    authScopes: { capability: "manage_members" },
    description: "Create a custom role for the active team.",
    args: { input: t.arg({ type: CreateRoleInputType, required: true }) },
    resolve: (_r, { input }) =>
      createRole({
        name: input.name,
        description: input.description ?? null,
        capabilities: (input.capabilities ?? undefined) as never,
      }),
  }),
  updateRole: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_members" },
    description:
      "Rename and/or re-scope a role. Every member holding it gets the new capability set immediately. Returns true.",
    args: { input: t.arg({ type: UpdateRoleInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await updateRole({
        id: input.id,
        name: input.name,
        description: input.description ?? null,
        capabilities: (input.capabilities ?? undefined) as never,
      });
      return true;
    },
  }),
  resetRole: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_members" },
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
    authScopes: { capability: "manage_members" },
    description:
      "Delete a custom role. Refuses while any member still holds it. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteRole(id);
      return true;
    },
  }),
}));
