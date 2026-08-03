import { builder } from "../builder";
import { CapabilityEnum } from "./enums";
import {
  addUserToTeam,
  removeUserFromTeam,
  setUserTeamAccess,
  type AccessNodeGrant,
  type UserTeamAccessDTO,
} from "@/lib/data/user-access";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const AccessNodeKindEnum = builder.enumType("AccessNodeKind", {
  values: ["project", "folder", "app"] as const,
  description: "What a per-node capability set is attached to.",
});

export const AccessNodeGrantRef = builder
  .objectRef<AccessNodeGrant>("AccessNodeGrant")
  .implement({
    description:
      "A capability set attached to one project, folder or app. It REPLACES the team role's set inside that node, and may grant more than the role does.",
    fields: (t) => ({
      kind: t.field({ type: AccessNodeKindEnum, resolve: (n) => n.kind }),
      nodeId: t.exposeID("nodeId"),
      name: t.exposeString("name"),
      capabilities: t.field({
        type: [CapabilityEnum],
        resolve: (n) => n.capabilities,
      }),
    }),
  });

export const UserTeamAccessRef = builder
  .objectRef<UserTeamAccessDTO>("UserTeamAccess")
  .implement({
    description: "What one person can do in one team, as an instance admin sets it.",
    fields: (t) => ({
      teamId: t.exposeID("teamId"),
      teamName: t.exposeString("teamName"),
      roleId: t.exposeID("roleId", { nullable: true }),
      roleName: t.exposeString("roleName", { nullable: true }),
      rank: t.exposeString("rank", {
        description: "`owner` outranks everyone; anything else ranks as a member.",
      }),
      granular: t.exposeBoolean("granular", {
        description:
          "Per-node overrides are in play on top of the role. Stored as the admin's choice, so deleting the last granted node doesn't silently turn it off.",
      }),
      baseCapabilities: t.field({
        type: [CapabilityEnum],
        description: "What applies outside every granted node.",
        resolve: (a) => a.baseCapabilities,
      }),
      nodes: t.field({ type: [AccessNodeGrantRef], resolve: (a) => a.nodes }),
      isFounder: t.exposeBoolean("isFounder", {
        description:
          "The team's primary owner. Their access can't be changed by anyone, instance admins included.",
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const NodeGrantInputType = builder.inputType("NodeGrantInput", {
  description:
    "One capability set, applied to every node named here. Send several to give different nodes different sets.",
  fields: (t) => ({
    projectIds: t.stringList({ required: false }),
    folderIds: t.stringList({ required: false }),
    appIds: t.stringList({ required: false }),
    capabilities: t.field({ type: [CapabilityEnum], required: true }),
  }),
});

const SetUserTeamAccessInputType = builder.inputType("SetUserTeamAccessInput", {
  fields: (t) => ({
    userId: t.string({ required: true }),
    teamId: t.string({ required: true }),
    roleId: t.string({ required: true }),
    granular: t.boolean({ required: true }),
    // Ignored unless `granular` is true — the mode is the admin's choice, and a
    // stale grant list must not quietly apply to someone switched back to Role.
    grants: t.field({ type: [NodeGrantInputType], required: false }),
  }),
});

const UserTeamInputType = builder.inputType("UserTeamInput", {
  fields: (t) => ({
    userId: t.string({ required: true }),
    teamId: t.string({ required: true }),
    roleId: t.string({ required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  setUserTeamAccess: t.field({
    type: [UserTeamAccessRef],
    authScopes: { instanceAdmin: true },
    description:
      "Set one person's role and per-node overrides in one team. Whole-set replace: node grants not sent are removed.",
    args: { input: t.arg({ type: SetUserTeamAccessInputType, required: true }) },
    resolve: (_root, { input }) =>
      setUserTeamAccess({
        userId: input.userId,
        teamId: input.teamId,
        roleId: input.roleId,
        granular: input.granular,
        grants: (input.grants ?? []).map((g) => ({
          projectIds: g.projectIds ?? undefined,
          folderIds: g.folderIds ?? undefined,
          appIds: g.appIds ?? undefined,
          // The enum resolves to capability strings; the data layer re-validates
          // every one against NODE_GRANTABLE_CAPABILITIES anyway (same cast as
          // the role resolvers).
          capabilities: g.capabilities as never,
        })),
      }),
  }),
  addUserToTeam: t.field({
    type: [UserTeamAccessRef],
    authScopes: { instanceAdmin: true },
    description: "Put this person in a team with a role.",
    args: { input: t.arg({ type: UserTeamInputType, required: true }) },
    resolve: (_root, { input }) => {
      if (!input.roleId) throw new Error("Choose a role for this member");
      return addUserToTeam({
        userId: input.userId,
        teamId: input.teamId,
        roleId: input.roleId,
      });
    },
  }),
  removeUserFromTeam: t.field({
    type: [UserTeamAccessRef],
    authScopes: { instanceAdmin: true },
    description:
      "Take this person out of a team. Since node grants are scoped to a team, this is the one action that revokes all of them at once.",
    args: { input: t.arg({ type: UserTeamInputType, required: true }) },
    resolve: (_root, { input }) =>
      removeUserFromTeam({ userId: input.userId, teamId: input.teamId }),
  }),
}));
