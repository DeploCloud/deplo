import { builder } from "../builder";
import { RoleEnum, CapabilityEnum } from "./enums";
import {
  listMembers,
  searchUsers,
  addExistingMember,
  updateMember,
  removeMember,
  listAllUsers,
  getUserDetail,
  updateUserAdmin,
  mintRegistrationLink,
  listRegistrationLinks,
  revokeRegistrationLink,
  type MemberDTO,
  type UserSearchResult,
  type GlobalUserDTO,
  type UserDetailDTO,
  type RegistrationLinkDTO,
} from "@/lib/data/members";
import {
  transferInstanceOwner,
  viewerIsInstanceOwner,
} from "@/lib/data/instance-owner";
import {
  getDeleteUserImpact,
  deleteUser,
  type DeleteUserImpact,
  type DeleteUserTeamImpact,
  type DeleteUserResult,
} from "@/lib/data/user-delete";

/* ------------------------------------------------------------------ */
/* Local enums                                                         */
/* ------------------------------------------------------------------ */

// RegistrationLinkStatus is a small domain union not shared in enums.ts, so it
// lives locally — defined, used, and not exported.
const RegistrationLinkStatusEnum = builder.enumType("RegistrationLinkStatus", {
  values: ["pending", "used", "revoked"] as const,
});

// How a registration link decides the registrant's team(s): own_team (name +
// own a fresh team) or existing_teams (admin pre-assigned to existing teams).
const RegistrationModeEnum = builder.enumType("RegistrationMode", {
  values: ["own_team", "existing_teams"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const MemberRef = builder.objectRef<MemberDTO>("Member").implement({
  description: "A user's membership in the active team (no email exposed).",
  fields: (t) => ({
    userId: t.exposeID("userId"),
    membershipId: t.exposeID("membershipId"),
    username: t.exposeString("username"),
    name: t.exposeString("name"),
    role: t.field({ type: RoleEnum, resolve: (m) => m.role }),
    capabilities: t.field({
      type: [CapabilityEnum],
      resolve: (m) => m.capabilities,
    }),
    // The absolute-owner ("crown") + instance-admin distinctions: graphical
    // badges in the member list, and (for the founder) the gating of which
    // members the viewer may edit/remove. See MemberDTO in lib/data/members.ts.
    isPrimaryOwner: t.exposeBoolean("isPrimaryOwner"),
    isInstanceAdmin: t.exposeBoolean("isInstanceAdmin"),
    avatarColor: t.exposeString("avatarColor"),
    createdAt: t.exposeString("createdAt"),
  }),
});

export const UserSearchResultRef = builder
  .objectRef<UserSearchResult>("UserSearchResult")
  .implement({
    description:
      "A registered user matched by username/display name when adding members.",
    fields: (t) => ({
      userId: t.exposeID("userId"),
      username: t.exposeString("username"),
      name: t.exposeString("name"),
      avatarColor: t.exposeString("avatarColor"),
      teamName: t.exposeString("teamName", { nullable: true }),
    }),
  });

export const GlobalUserRef = builder
  .objectRef<GlobalUserDTO>("GlobalUser")
  .implement({
    description:
      "A registered user in the instance-wide Users list (no email exposed).",
    fields: (t) => ({
      userId: t.exposeID("userId"),
      username: t.exposeString("username"),
      name: t.exposeString("name"),
      avatarColor: t.exposeString("avatarColor"),
      teamCount: t.exposeInt("teamCount"),
      isInstanceAdmin: t.exposeBoolean("isInstanceAdmin"),
      isInstanceOwner: t.exposeBoolean("isInstanceOwner", {
        description:
          "Owns the instance. Their account is editable only by themselves.",
      }),
      suspended: t.exposeBoolean("suspended"),
      canExposePorts: t.exposeBoolean("canExposePorts"),
      canMountHostVolumes: t.exposeBoolean("canMountHostVolumes"),
      createdAt: t.exposeString("createdAt"),
    }),
  });

// Nested rows of UserDetailDTO. These are plain inline shapes on the DTO, so we
// mirror them as their own object types built from the structural slice.
const UserDetailTeamRef = builder
  .objectRef<UserDetailDTO["teams"][number]>("UserDetailTeam")
  .implement({
    fields: (t) => ({
      teamId: t.exposeID("teamId"),
      teamName: t.exposeString("teamName"),
      role: t.field({ type: RoleEnum, resolve: (x) => x.role }),
    }),
  });

const UserActivityRef = builder
  .objectRef<UserDetailDTO["recentActivity"][number]>("UserActivity")
  .implement({
    fields: (t) => ({
      message: t.exposeString("message"),
      createdAt: t.exposeString("createdAt"),
    }),
  });

export const UserDetailRef = builder
  .objectRef<UserDetailDTO>("UserDetail")
  .implement({
    description:
      "Full per-user detail for the admin editor — the email IS included here.",
    fields: (t) => ({
      userId: t.exposeID("userId"),
      username: t.exposeString("username"),
      name: t.exposeString("name"),
      email: t.exposeString("email"),
      avatarColor: t.exposeString("avatarColor"),
      isInstanceAdmin: t.exposeBoolean("isInstanceAdmin"),
      isInstanceOwner: t.exposeBoolean("isInstanceOwner", {
        description:
          "Owns the instance. Their account is editable only by themselves.",
      }),
      suspended: t.exposeBoolean("suspended"),
      canExposePorts: t.exposeBoolean("canExposePorts"),
      canMountHostVolumes: t.exposeBoolean("canMountHostVolumes"),
      createdAt: t.exposeString("createdAt"),
      teams: t.field({ type: [UserDetailTeamRef], resolve: (u) => u.teams }),
      recentActivity: t.field({
        type: [UserActivityRef],
        resolve: (u) => u.recentActivity,
      }),
    }),
  });

/* --- Deleting an account: the preview, and what the delete removed --- */

const DeleteUserTeamImpactRef = builder
  .objectRef<DeleteUserTeamImpact>("DeleteUserTeamImpact")
  .implement({
    description: "A team affected by deleting a user, and what it holds.",
    fields: (t) => ({
      teamId: t.exposeID("teamId"),
      name: t.exposeString("name"),
      appCount: t.exposeInt("appCount"),
      databaseCount: t.exposeInt("databaseCount"),
      otherMemberCount: t.exposeInt("otherMemberCount"),
    }),
  });

const DeleteUserKeptTeamRef = builder
  .objectRef<DeleteUserImpact["keptTeams"][number]>("DeleteUserKeptTeam")
  .implement({
    fields: (t) => ({
      teamId: t.exposeID("teamId"),
      name: t.exposeString("name"),
    }),
  });

export const DeleteUserImpactRef = builder
  .objectRef<DeleteUserImpact>("DeleteUserImpact")
  .implement({
    description:
      "Exactly what permanently deleting an account would take with it — read live so the confirmation states facts, not warnings.",
    fields: (t) => ({
      userId: t.exposeID("userId"),
      username: t.exposeString("username"),
      name: t.exposeString("name"),
      blockedReason: t.exposeString("blockedReason", {
        nullable: true,
        description:
          "Non-null ⇒ this account can't be deleted at all; the reason to show.",
      }),
      soloTeams: t.field({
        type: [DeleteUserTeamImpactRef],
        description:
          "Teams where they are the ONLY member — always deleted with the account, since nobody would be left who could ever open them.",
        resolve: (i) => i.soloTeams,
      }),
      foundedTeams: t.field({
        type: [DeleteUserTeamImpactRef],
        description:
          "Teams they founded that still have other members — deleted only on request.",
        resolve: (i) => i.foundedTeams,
      }),
      keptTeams: t.field({
        type: [DeleteUserKeptTeamRef],
        description: "Teams that keep everything, minus this membership.",
        resolve: (i) => i.keptTeams,
      }),
      createdAppCount: t.exposeInt("createdAppCount"),
      ownedFolderCount: t.exposeInt("ownedFolderCount"),
      ownedProjectCount: t.exposeInt("ownedProjectCount"),
      ownedAppCount: t.exposeInt("ownedAppCount"),
      tokenCount: t.exposeInt("tokenCount"),
      vacatedTeams: t.field({
        type: ["String"],
        description:
          "Surviving teams whose last member/team manager this account is. The delete hands that capability to their longest-standing remaining member.",
        resolve: (i) => i.vacatedTeams,
      }),
    }),
  });

export const DeleteUserResultRef = builder
  .objectRef<DeleteUserResult>("DeleteUserResult")
  .implement({
    description: "What a completed account deletion actually removed.",
    fields: (t) => ({
      username: t.exposeString("username"),
      teamsDeleted: t.exposeInt("teamsDeleted"),
      appsDeleted: t.exposeInt("appsDeleted"),
      databasesDeleted: t.exposeInt("databasesDeleted"),
    }),
  });

export const RegistrationLinkRef = builder
  .objectRef<RegistrationLinkDTO>("RegistrationLink")
  .implement({
    description: "A single-use link to register a new account.",
    fields: (t) => ({
      id: t.exposeID("id"),
      status: t.field({
        type: RegistrationLinkStatusEnum,
        resolve: (l) => l.status,
      }),
      mode: t.field({ type: RegistrationModeEnum, resolve: (l) => l.mode }),
      // For existing_teams links: the names of the assigned teams (else empty).
      teamNames: t.field({ type: ["String"], resolve: (l) => l.teamNames }),
      createdBy: t.exposeString("createdBy"),
      usedByUsername: t.exposeString("usedByUsername", { nullable: true }),
      expiresAt: t.exposeString("expiresAt"),
      createdAt: t.exposeString("createdAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const AddMemberInputType = builder.inputType("AddMemberInput", {
  fields: (t) => ({
    userId: t.string({ required: true }),
    role: t.field({ type: RoleEnum, required: true }),
    capabilities: t.field({ type: [CapabilityEnum], required: false }),
  }),
});

const UpdateMemberInputType = builder.inputType("UpdateMemberInput", {
  fields: (t) => ({
    userId: t.string({ required: true }),
    role: t.field({ type: RoleEnum, required: true }),
    capabilities: t.field({ type: [CapabilityEnum], required: false }),
  }),
});

const UpdateUserAdminInputType = builder.inputType("UpdateUserAdminInput", {
  fields: (t) => ({
    userId: t.string({ required: true }),
    isInstanceAdmin: t.boolean({ required: true }),
    suspended: t.boolean({ required: true }),
    // Instance-wide grants. Optional so older clients keep working; omitted ⇒
    // the user's current value is preserved (resolved in the resolver).
    canExposePorts: t.boolean({ required: false }),
    canMountHostVolumes: t.boolean({ required: false }),
    newPassword: t.string({ required: false }),
  }),
});

// The three "go deeper" choices the delete-account dialog offers. All optional
// and all defaulting to FALSE server-side: an omitted flag must never be read as
// "yes, destroy that too".
const DeleteUserInputType = builder.inputType("DeleteUserInput", {
  fields: (t) => ({
    userId: t.string({ required: true }),
    deleteCreatedApps: t.boolean({ required: false }),
    deleteOwnedWorkspaces: t.boolean({ required: false }),
    deleteFoundedTeams: t.boolean({ required: false }),
  }),
});

// One existing team a new user is pre-assigned to, with their role + (optional)
// fine-tuned capabilities. Used only when minting an `existing_teams` link.
const RegistrationTeamAssignmentInput = builder.inputType(
  "RegistrationTeamAssignmentInput",
  {
    fields: (t) => ({
      teamId: t.string({ required: true }),
      role: t.field({ type: RoleEnum, required: true }),
      capabilities: t.field({ type: [CapabilityEnum], required: false }),
    }),
  },
);

const MintRegistrationLinkInputType = builder.inputType(
  "MintRegistrationLinkInput",
  {
    fields: (t) => ({
      mode: t.field({ type: RegistrationModeEnum, required: true }),
      // Required + non-empty iff mode is existing_teams; ignored for own_team.
      teamAssignments: t.field({
        type: [RegistrationTeamAssignmentInput],
        required: false,
      }),
    }),
  },
);

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  members: t.field({
    type: [MemberRef],
    authScopes: { loggedIn: true },
    description: "Members of the active team, oldest first.",
    resolve: () => listMembers(),
  }),
  searchUsers: t.field({
    type: [UserSearchResultRef],
    authScopes: { loggedIn: true },
    description:
      "Search registered users (by username/display name) to add to the team.",
    args: { query: t.arg.string({ required: true }) },
    resolve: (_r, { query }) => searchUsers(query),
  }),
  allUsers: t.field({
    type: [GlobalUserRef],
    authScopes: { instanceAdmin: true },
    description: "Every registered user on the instance (no email).",
    resolve: () => listAllUsers(),
  }),
  userDetail: t.field({
    type: UserDetailRef,
    authScopes: { instanceAdmin: true },
    description: "Full detail (incl. email) for one user.",
    args: { userId: t.arg.string({ required: true }) },
    resolve: (_r, { userId }) => getUserDetail(userId),
  }),
  deleteUserImpact: t.field({
    type: DeleteUserImpactRef,
    authScopes: { instanceAdmin: true },
    description:
      "What permanently deleting this account would remove. Read-only — nothing is deleted.",
    args: { userId: t.arg.string({ required: true }) },
    resolve: (_r, { userId }) => getDeleteUserImpact(userId),
  }),
  registrationLinks: t.field({
    type: [RegistrationLinkRef],
    authScopes: { instanceAdmin: true },
    description: "Pending + recent registration links, newest first.",
    resolve: () => listRegistrationLinks(),
  }),
  viewerIsInstanceOwner: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Whether the viewer owns this instance (the tier above instance admin).",
    resolve: () => viewerIsInstanceOwner(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every member/user-admin/registration server action)      */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  addExistingMember: t.field({
    type: MemberRef,
    authScopes: { capability: "manage_members" },
    description: "Add an already-registered user to the active team.",
    args: { input: t.arg({ type: AddMemberInputType, required: true }) },
    resolve: (_r, { input }) =>
      addExistingMember({
        userId: input.userId,
        role: input.role,
        capabilities: (input.capabilities ?? undefined) as never,
      }),
  }),
  updateMember: t.field({
    type: MemberRef,
    authScopes: { capability: "manage_members" },
    description: "Change a member's role and/or capabilities.",
    args: { input: t.arg({ type: UpdateMemberInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await updateMember({
        userId: input.userId,
        role: input.role,
        capabilities: (input.capabilities ?? undefined) as never,
      });
      return reloadMember(input.userId);
    },
  }),
  removeMember: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_members" },
    description: "Remove a member from the active team. Returns true.",
    args: { userId: t.arg.string({ required: true }) },
    resolve: async (_r, { userId }) => {
      await removeMember(userId);
      return true;
    },
  }),
  mintRegistrationLink: t.field({
    type: "String",
    authScopes: { instanceAdmin: true },
    description:
      "Mint a single-use registration link. Returns the absolute /register URL.",
    args: { input: t.arg({ type: MintRegistrationLinkInputType, required: true }) },
    resolve: async (_r, { input }) => {
      const { link } = await mintRegistrationLink({
        mode: input.mode,
        teamAssignments:
          input.teamAssignments?.map((a) => ({
            teamId: a.teamId,
            role: a.role,
            capabilities: (a.capabilities ?? undefined) as never,
          })) ?? undefined,
      });
      return link;
    },
  }),
  revokeRegistrationLink: t.field({
    type: "Boolean",
    authScopes: { instanceAdmin: true },
    description: "Revoke a pending registration link. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await revokeRegistrationLink(id);
      return true;
    },
  }),
  updateUserAdmin: t.field({
    type: UserDetailRef,
    authScopes: { instanceAdmin: true },
    description:
      "Edit a user's instance-admin flag, suspended state, and password.",
    args: { input: t.arg({ type: UpdateUserAdminInputType, required: true }) },
    resolve: async (_r, { input }) => {
      // Grants are optional in the input; an omitted (null) flag preserves the
      // user's current value rather than silently clearing it.
      const current = await getUserDetail(input.userId);
      await updateUserAdmin({
        userId: input.userId,
        isInstanceAdmin: input.isInstanceAdmin,
        suspended: input.suspended,
        canExposePorts: input.canExposePorts ?? current.canExposePorts,
        canMountHostVolumes:
          input.canMountHostVolumes ?? current.canMountHostVolumes,
        newPassword: input.newPassword ?? undefined,
      });
      return getUserDetail(input.userId);
    },
  }),
  deleteUser: t.field({
    type: DeleteUserResultRef,
    authScopes: { instanceAdmin: true },
    description:
      "Permanently delete a user account. Teams they are the only member of always go with it; the rest is opt-in.",
    args: { input: t.arg({ type: DeleteUserInputType, required: true }) },
    resolve: (_r, { input }) =>
      deleteUser(input.userId, {
        deleteCreatedApps: input.deleteCreatedApps ?? false,
        deleteOwnedWorkspaces: input.deleteOwnedWorkspaces ?? false,
        deleteFoundedTeams: input.deleteFoundedTeams ?? false,
      }),
  }),
  transferInstanceOwner: t.field({
    type: "Boolean",
    // instanceAdmin is the FLOOR, not the gate — the data layer additionally
    // requires the caller to BE the current owner, which no scope can express.
    authScopes: { instanceAdmin: true },
    description:
      "Hand instance ownership to another instance admin. Owner-only; requires the caller's password. Returns true.",
    args: {
      userId: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
    },
    resolve: async (_r, { userId, password }) => {
      await transferInstanceOwner({ userId, password });
      return true;
    },
  }),
}));

/** Reload a member by id after a void mutation so we can return the entity. */
async function reloadMember(userId: string): Promise<MemberDTO> {
  const all = await listMembers();
  const found = all.find((m) => m.userId === userId);
  if (!found) throw new Error("Member not found");
  return found;
}
