import { builder } from "../builder";
import { RoleEnum, CapabilityEnum } from "./enums";
import { addExistingMember, updateMember } from "@/lib/data/members/assignment";
import {
  listAllUsers,
  getUserDetail,
  updateUserAdmin,
  resetUserPasskeys,
  resetUserTwoFactor,
  type GlobalUserDTO,
  type UserDetailDTO,
} from "@/lib/data/members/instance-users";
import {
  mintRegistrationLink,
  listRegistrationLinks,
  revealRegistrationLink,
  revokeRegistrationLink,
  revokeAllRegistrationLinks,
  type RegistrationLinkDTO,
} from "@/lib/data/members/registration-links";
import { removeMember } from "@/lib/data/members/removal";
import { listMembers, type MemberDTO } from "@/lib/data/members/roster";
import {
  searchUsers,
  type UserSearchResult,
} from "@/lib/data/members/user-search";
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

const RegistrationLinkStatusEnum = builder.enumType("RegistrationLinkStatus", {
  values: ["pending", "used", "revoked"] as const,
});

const RegistrationModeEnum = builder.enumType("RegistrationMode", {
  values: ["own_team", "existing_teams"] as const,
});

export const MemberRef = builder.objectRef<MemberDTO>("Member").implement({
  description: "A user's membership in the active team (no email exposed).",
  fields: (t) => ({
    userId: t.exposeID("userId"),
    membershipId: t.exposeID("membershipId"),
    username: t.exposeString("username"),
    name: t.exposeString("name"),
    role: t.field({
      type: RoleEnum,
      description:
        "The member's RANK (only `owner` outranks). For what to show, read `roleName`.",
      resolve: (m) => m.role,
    }),
    roleId: t.exposeID("roleId", {
      nullable: true,
      description:
        "The assigned team role, or null when the member holds a hand-picked capability set.",
    }),
    roleName: t.exposeString("roleName", {
      nullable: true,
      description: "The assigned role's name, or null for a custom set.",
    }),
    capabilities: t.field({
      type: [CapabilityEnum],
      resolve: (m) => m.capabilities,
    }),
    isPrimaryOwner: t.exposeBoolean("isPrimaryOwner"),
    isInstanceAdmin: t.exposeBoolean("isInstanceAdmin"),
    avatarColor: t.exposeString("avatarColor"),
    avatarUrl: t.exposeString("avatarUrl", {
      nullable: true,
      description:
        "Resolved profile picture: uploaded image, else Gravatar, else null for the monogram.",
    }),
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
      avatarUrl: t.exposeString("avatarUrl", {
        nullable: true,
        description:
          "Resolved profile picture: uploaded image, else Gravatar, else null for the monogram.",
      }),
      teamName: t.exposeString("teamName", { nullable: true }),
      teamAvatarUrl: t.exposeString("teamAvatarUrl", { nullable: true }),
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
      avatarUrl: t.exposeString("avatarUrl", {
        nullable: true,
        description:
          "Resolved profile picture: uploaded image, else Gravatar, else null for the monogram.",
      }),
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

const UserDetailTeamRef = builder
  .objectRef<UserDetailDTO["teams"][number]>("UserDetailTeam")
  .implement({
    fields: (t) => ({
      teamId: t.exposeID("teamId"),
      teamName: t.exposeString("teamName"),
      teamAvatarUrl: t.exposeString("teamAvatarUrl", { nullable: true }),
      role: t.field({ type: RoleEnum, resolve: (x) => x.role }),
    }),
  });

export const UserDetailRef = builder
  .objectRef<UserDetailDTO>("UserDetail")
  .implement({
    description:
      "Full per-user detail for the admin editor - the email IS included here.",
    fields: (t) => ({
      userId: t.exposeID("userId"),
      username: t.exposeString("username"),
      name: t.exposeString("name"),
      email: t.exposeString("email"),
      avatarColor: t.exposeString("avatarColor"),
      avatarUrl: t.exposeString("avatarUrl", {
        nullable: true,
        description:
          "Resolved profile picture: uploaded image, else Gravatar, else null for the monogram.",
      }),
      isInstanceAdmin: t.exposeBoolean("isInstanceAdmin"),
      isInstanceOwner: t.exposeBoolean("isInstanceOwner", {
        description:
          "Owns the instance. Their account is editable only by themselves.",
      }),
      suspended: t.exposeBoolean("suspended"),
      canExposePorts: t.exposeBoolean("canExposePorts"),
      canMountHostVolumes: t.exposeBoolean("canMountHostVolumes"),
      twoFactorEnabled: t.exposeBoolean("twoFactorEnabled", {
        description:
          "Has an authenticator app enrolled. Only then is `resetUserTwoFactor` offered.",
      }),
      passkeyCount: t.exposeInt("passkeyCount", {
        description:
          "How many passkeys they hold. Only above zero is `resetUserPasskeys` offered.",
      }),
      createdAt: t.exposeString("createdAt"),
      teams: t.field({ type: [UserDetailTeamRef], resolve: (u) => u.teams }),
    }),
  });

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
      "Exactly what permanently deleting an account would take with it - read live so the confirmation states facts, not warnings.",
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
          "Teams where they are the ONLY member - always deleted with the account, since nobody would be left who could ever open them.",
        resolve: (i) => i.soloTeams,
      }),
      foundedTeams: t.field({
        type: [DeleteUserTeamImpactRef],
        description:
          "Teams they founded that still have other members - deleted only on request.",
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
      teamNames: t.field({ type: ["String"], resolve: (l) => l.teamNames }),
      createdBy: t.exposeString("createdBy"),
      usedByUsername: t.exposeString("usedByUsername", { nullable: true }),
      expiresAt: t.exposeString("expiresAt"),
      createdAt: t.exposeString("createdAt"),
      canReveal: t.exposeBoolean("canReveal", {
        description:
          "The link can still be read back with revealRegistrationLink - pending, unexpired, and minted after the token started being stored encrypted.",
      }),
      linkMasked: t.exposeString("linkMasked", {
        description:
          "The link with its token blanked, for display while it is covered. Never carries the token.",
      }),
    }),
  });

const AddMemberInputType = builder.inputType("AddMemberInput", {
  fields: (t) => ({
    userId: t.string({ required: true }),
    roleId: t.string({ required: false }),
    role: t.field({ type: RoleEnum, required: false }),
    capabilities: t.field({ type: [CapabilityEnum], required: false }),
  }),
});

const UpdateMemberInputType = builder.inputType("UpdateMemberInput", {
  fields: (t) => ({
    userId: t.string({ required: true }),
    roleId: t.string({ required: false }),
    role: t.field({ type: RoleEnum, required: false }),
    capabilities: t.field({ type: [CapabilityEnum], required: false }),
  }),
});

const UpdateUserAdminInputType = builder.inputType("UpdateUserAdminInput", {
  fields: (t) => ({
    userId: t.string({ required: true }),
    isInstanceAdmin: t.boolean({ required: true }),
    suspended: t.boolean({ required: true }),
    canExposePorts: t.boolean({ required: false }),
    canMountHostVolumes: t.boolean({ required: false }),
    newPassword: t.string({ required: false }),
  }),
});

// All optional and all defaulting to FALSE: an omitted flag must never be read as "destroy that too".
const DeleteUserInputType = builder.inputType("DeleteUserInput", {
  fields: (t) => ({
    userId: t.string({ required: true }),
    deleteCreatedApps: t.boolean({ required: false }),
    deleteOwnedWorkspaces: t.boolean({ required: false }),
    deleteFoundedTeams: t.boolean({ required: false }),
  }),
});

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
      teamAssignments: t.field({
        type: [RegistrationTeamAssignmentInput],
        required: false,
      }),
    }),
  },
);

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
      "What permanently deleting this account would remove. Read-only - nothing is deleted.",
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

builder.mutationFields((t) => ({
  addExistingMember: t.field({
    type: MemberRef,
    authScopes: { capability: "manage_members" },
    description: "Add an already-registered user to the active team.",
    args: { input: t.arg({ type: AddMemberInputType, required: true }) },
    resolve: (_r, { input }) =>
      addExistingMember({
        userId: input.userId,
        roleId: input.roleId ?? undefined,
        role: input.role ?? undefined,
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
        roleId: input.roleId ?? undefined,
        role: input.role ?? undefined,
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
    args: {
      input: t.arg({ type: MintRegistrationLinkInputType, required: true }),
    },
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
  revealRegistrationLink: t.field({
    type: "String",
    authScopes: { instanceAdmin: true },
    description:
      "The full registration URL of a link that is still pending, so the admin who minted it can hand it over again instead of minting a second one. Errors, rather than returning a dead URL, when the link was used, revoked, expired, or minted before the token was stored encrypted.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => revealRegistrationLink(id),
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
  revokeAllRegistrationLinks: t.field({
    type: "Int",
    authScopes: { instanceAdmin: true },
    description:
      "Revoke every pending registration link. Returns how many were revoked.",
    resolve: () => revokeAllRegistrationLinks(),
  }),
  updateUserAdmin: t.field({
    type: UserDetailRef,
    authScopes: { instanceAdmin: true },
    description:
      "Edit a user's instance-admin flag, suspended state, and password.",
    args: { input: t.arg({ type: UpdateUserAdminInputType, required: true }) },
    resolve: async (_r, { input }) => {
      // An omitted (null) grant preserves the user's current value rather than clearing it.
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
  resetUserTwoFactor: t.field({
    type: UserDetailRef,
    authScopes: { instanceAdmin: true },
    description:
      "Clear a user's two-factor enrolment so they can sign in with their password again. The escape hatch for a lost phone AND lost recovery codes; touches no credential and no session.",
    args: { userId: t.arg.string({ required: true }) },
    resolve: async (_r, { userId }) => {
      await resetUserTwoFactor(userId);
      return getUserDetail(userId);
    },
  }),
  resetUserPasskeys: t.field({
    type: UserDetailRef,
    authScopes: { instanceAdmin: true },
    description:
      "Remove every passkey from a user's account. The escape hatch for a lost device: while a dead passkey exists it still satisfies the account's two-factor policy. Touches no password and no session.",
    args: { userId: t.arg.string({ required: true }) },
    resolve: async (_r, { userId }) => {
      await resetUserPasskeys(userId);
      return getUserDetail(userId);
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
    // instanceAdmin is the FLOOR: the data layer additionally requires the caller to BE the owner.
    authScopes: { instanceAdmin: true },
    description:
      "Hand instance ownership to another instance admin. Owner-only; requires the caller's password, plus a two-factor code when their account has 2FA on. Returns true.",
    args: {
      userId: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
      code: t.arg.string({ required: false }),
    },
    resolve: async (_r, { userId, password, code }) => {
      await transferInstanceOwner({
        userId,
        password,
        code: code ?? undefined,
      });
      return true;
    },
  }),
}));

async function reloadMember(userId: string): Promise<MemberDTO> {
  const all = await listMembers();
  const found = all.find((m) => m.userId === userId);
  if (!found) throw new Error("Member not found");
  return found;
}
