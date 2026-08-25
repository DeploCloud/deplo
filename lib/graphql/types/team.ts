import { builder } from "../builder";
import {
  getTeam,
  listMyTeams,
  listAllTeamsForAdmin,
  updateTeam,
  createTeam,
  switchTeam,
  updateTeamAvatar,
  reorderMyTeams,
} from "@/lib/data/teams";
import { deleteTeam } from "@/lib/data/team-delete";
import { transferTeamOwnership } from "@/lib/data/team-ownership";
import type { Team, TeamSummary } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

// The plan union ("pro" | "enterprise") is team-local — not shared in
// enums.ts — so we define it here and export nothing.
const TeamPlanEnum = builder.enumType("TeamPlan", {
  values: ["pro", "enterprise"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const TeamRef = builder.objectRef<Team>("Team").implement({
  description: "A team that owns apps, infra and members.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    slug: t.exposeString("slug"),
    plan: t.field({ type: TeamPlanEnum, resolve: (x) => x.plan }),
    requireTwoFactor: t.boolean({
      description:
        "Whether every member of this team must have two-factor authentication.",
      resolve: (x) => x.requireTwoFactor ?? false,
    }),
    avatarUrl: t.exposeString("avatarUrl", {
      nullable: true,
      description:
        "The team's picture, or null for its two-letter monogram. A team has no email, so there is no Gravatar step.",
    }),
    createdAt: t.exposeString("createdAt"),
  }),
});

// A team as it appears in the switcher: the viewer's role in it plus its size.
// listMyTeams returns Team & { role, memberCount }, so we mirror that as a
// distinct type rather than overloading the bare Team object.
export const TeamMembershipRef = builder
  .objectRef<TeamSummary>("TeamMembership")
  .implement({
    description:
      "A team the viewer belongs to, carrying their role and the team size.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
      plan: t.field({ type: TeamPlanEnum, resolve: (x) => x.plan }),
      avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
      createdAt: t.exposeString("createdAt"),
      role: t.exposeString("role"),
      memberCount: t.exposeInt("memberCount"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const UpdateTeamInputType = builder.inputType("UpdateTeamInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    slug: t.string({ required: true }),
    // Optional so a plain rename never silently rewrites the security policy:
    // omitted means "leave it as it is", not "turn it off".
    requireTwoFactor: t.boolean({ required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  viewerTeam: t.field({
    type: TeamRef,
    authScopes: { loggedIn: true },
    description: "The active team.",
    resolve: () => getTeam(),
  }),
  myTeams: t.field({
    type: [TeamMembershipRef],
    authScopes: { loggedIn: true },
    description: "Every team the viewer belongs to, for the team switcher.",
    resolve: () => listMyTeams(),
  }),
  allTeamsForAdmin: t.field({
    type: [TeamRef],
    authScopes: { instanceAdmin: true },
    description:
      "Every team in the instance, for the instance-admin registration-link team picker.",
    resolve: () => listAllTeamsForAdmin(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every team server action)                                */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  updateTeam: t.field({
    type: TeamRef,
    authScopes: { capability: "manage_team" },
    args: { input: t.arg({ type: UpdateTeamInputType, required: true }) },
    resolve: (_r, { input }) =>
      updateTeam({
        name: input.name,
        slug: input.slug,
        requireTwoFactor: input.requireTwoFactor ?? undefined,
      }),
  }),
  updateTeamAvatar: t.field({
    type: TeamRef,
    authScopes: { capability: "manage_team" },
    description:
      "Set or clear the active team's picture. Same gate as renaming the team, because it IS the same action - how the team presents itself. The value is a base64 image data-URI (png/jpeg/webp); null or empty removes it and falls back to the two-letter monogram.",
    args: { image: t.arg.string({ required: false }) },
    resolve: (_r, { image }) => updateTeamAvatar(image ?? null),
  }),
  reorderMyTeams: t.field({
    type: "Boolean",
    // NOT capability-gated, and deliberately: this is nobody's team setting, it is
    // where YOUR switcher puts things.
    authScopes: { loggedIn: true },
    description:
      "Set the current user's own order for the topbar team switcher, first to last. Personal, never team-wide: nobody else's list moves. Ids the user is not a member of are ignored, and any team left out of the list keeps its place at the end. Returns true.",
    args: { teamIds: t.arg.stringList({ required: true }) },
    resolve: async (_r, { teamIds }) => {
      await reorderMyTeams(teamIds);
      return true;
    },
  }),
  transferTeamOwnership: t.field({
    type: "Boolean",
    // manage_team is the FLOOR, not the gate — the data layer additionally
    // requires the caller to BE the team's primary owner, which no capability
    // expresses.
    authScopes: { capability: "manage_team" },
    description:
      "Hand the active team to another member, who is put on the Owner role " +
      "with the whole team in reach as part of the same write. Primary-owner " +
      "only; requires the caller's password, plus a two-factor code when their " +
      "account has 2FA on. Returns true.",
    args: {
      userId: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
      code: t.arg.string({ required: false }),
    },
    resolve: async (_r, { userId, password, code }) => {
      await transferTeamOwnership({
        userId,
        password,
        code: code ?? undefined,
      });
      return true;
    },
  }),
  createTeam: t.field({
    type: TeamRef,
    authScopes: { loggedIn: true },
    description:
      "Create a new team; the viewer becomes its owner and it is made active.",
    args: { name: t.arg.string({ required: true }) },
    resolve: (_r, { name }) => createTeam({ name }),
  }),
  switchTeam: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Switch the active team (sets a cookie server-side). Returns true.",
    args: { teamId: t.arg.string({ required: true }) },
    resolve: async (_r, { teamId }) => {
      await switchTeam(teamId);
      return true;
    },
  }),
  deleteTeam: t.field({
    type: "Boolean",
    // loggedIn only: the founder/instance-admin gate (tighter than any
    // capability — see lib/data/team-delete.ts) is enforced in the data layer.
    authScopes: { loggedIn: true },
    description:
      "Permanently delete a team. teamId must be the ACTIVE team (the delete " +
      "fails closed if the active team changed since the page was loaded). " +
      "Removes every team-scoped record; the app/database stack teardown " +
      "continues in the background. Founder or instance admin only; the " +
      "caller's last team can't be deleted. Returns true.",
    args: { teamId: t.arg.string({ required: true }) },
    resolve: async (_r, { teamId }) => {
      await deleteTeam(teamId);
      return true;
    },
  }),
}));
