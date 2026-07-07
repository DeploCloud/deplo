import { builder } from "../builder";
import {
  getTeam,
  listMyTeams,
  listAllTeams,
  listAllTeamsForAdmin,
  updateTeam,
  createTeam,
  switchTeam,
} from "@/lib/data/teams";
import { deleteTeam } from "@/lib/data/team-delete";
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
  description: "A team that owns services, infra and members.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    slug: t.exposeString("slug"),
    plan: t.field({ type: TeamPlanEnum, resolve: (x) => x.plan }),
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
  assignableTeams: t.field({
    type: [TeamRef],
    authScopes: { capability: "manage_infra" },
    description:
      "Every team in the instance, for the server team-access picker. Requires manage_infra.",
    resolve: () => listAllTeams(),
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
      updateTeam({ name: input.name, slug: input.slug }),
  }),
  createTeam: t.field({
    type: TeamRef,
    authScopes: { loggedIn: true },
    description: "Create a new team; the viewer becomes its owner and it is made active.",
    args: { name: t.arg.string({ required: true }) },
    resolve: (_r, { name }) => createTeam({ name }),
  }),
  switchTeam: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description: "Switch the active team (sets a cookie server-side). Returns true.",
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
      "Removes every team-scoped record; the service/database stack teardown " +
      "continues in the background. Founder or instance admin only; the " +
      "caller's last team can't be deleted. Returns true.",
    args: { teamId: t.arg.string({ required: true }) },
    resolve: async (_r, { teamId }) => {
      await deleteTeam(teamId);
      return true;
    },
  }),
}));
