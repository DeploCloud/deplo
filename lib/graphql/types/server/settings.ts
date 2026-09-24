import { builder } from "../../builder";
import { ServerRef } from "./server-ref";
import { type ServerRole } from "@/lib/data/servers/roster";
import {
  renameServer,
  setServerAgentCanary,
  setServerDeployConcurrency,
  setServerBuildFallback,
  setServerRole,
} from "@/lib/data/servers/settings";
import { setServerTeams } from "@/lib/data/servers/team-access";

const SetServerTeamsInputType = builder.inputType("SetServerTeamsInput", {
  description:
    "Set which teams may target a server. allTeams: true opens it to every team (clearing specific grants); false restricts it to teamIds.",
  fields: (t) => ({
    serverId: t.string({ required: true }),
    allTeams: t.boolean({ required: true }),
    teamIds: t.stringList({ required: false }),
  }),
});

builder.mutationFields((t) => ({
  renameServer: t.field({
    type: ServerRef,
    authScopes: { instanceAdmin: true },
    description:
      "Change a server's display name. Cosmetic: nothing dials, routes or deploys by name.",
    args: {
      id: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: (_r, { id, name }) => renameServer(id, name),
  }),
  setServerRole: t.field({
    type: ServerRef,
    authScopes: { instanceAdmin: true },
    description:
      'Change what a server is for: "everything", "build" or "storage". Leaving "everything" is refused while the host still has apps or databases on it. A server INSTALLED as backups-only has no Docker and stays pinned to "storage" until its install command is re-run on the host. "import" is not settable and a migration source is not convertible: the install command is the way in and the way out.',
    args: {
      id: t.arg.string({ required: true }),
      role: t.arg.string({ required: true }),
    },
    resolve: (_r, { id, role }) => setServerRole(id, role as ServerRole),
  }),
  setServerBuildFallback: t.field({
    type: ServerRef,
    authScopes: { instanceAdmin: true },
    description:
      "Whether this host may compile for an app whose own build server could not be reached (the app's own server stays the last resort). Omit the flag to go back to automatic: the Deplo host builds as a fallback, no other server does. Refused on a host with no Docker of ours to build with.",
    args: {
      id: t.arg.string({ required: true }),
      buildFallback: t.arg.boolean({ required: false }),
    },
    resolve: (_r, { id, buildFallback }) =>
      setServerBuildFallback(id, buildFallback ?? null),
  }),
  setServerAgentCanary: t.field({
    type: ServerRef,
    authScopes: { instanceAdmin: true },
    description:
      "Offer this server's agent canary (pre-release) versions as updates, or go back to stable ones. Nothing is installed by the switch: a newer version shows up as an update, and turning it off never downgrades an agent already on a canary.",
    args: {
      id: t.arg.string({ required: true }),
      agentCanary: t.arg.boolean({ required: true }),
    },
    resolve: (_r, { id, agentCanary }) => setServerAgentCanary(id, agentCanary),
  }),
  setServerTeams: t.field({
    type: ServerRef,
    authScopes: { instanceAdmin: true },
    description:
      "Set a server's team access. allTeams: true makes it available to every team; false restricts it to teamIds. Blocked (clear error) when a team that still has apps or databases on the server would lose access.",
    args: { input: t.arg({ type: SetServerTeamsInputType, required: true }) },
    resolve: (_r, { input }) =>
      setServerTeams(input.serverId, {
        allTeams: input.allTeams,
        teamIds: input.teamIds ?? [],
      }),
  }),
  setServerDeployConcurrency: t.field({
    type: ServerRef,
    authScopes: { instanceAdmin: true },
    description:
      "Set how many deployments this server runs at once (the per-server slot count the deploy queue enforces). 1 = strict serialization. Whole number in [1, 50].",
    args: {
      id: t.arg.string({ required: true }),
      concurrency: t.arg.int({ required: true }),
    },
    resolve: (_r, { id, concurrency }) =>
      setServerDeployConcurrency(id, concurrency),
  }),
}));
