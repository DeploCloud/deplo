import { builder } from "../builder";
import { TeamRef } from "./team";
import {
  listServers,
  getServer,
  getPrimaryServer,
  getServerTeams,
  addServer,
  reissueBootstrap,
  removeServer,
  updateServerAgent,
  setServerTeams,
} from "@/lib/data/servers";
import {
  isAgentOutdated,
  reportedAgentVersion,
  resolveExpectedAgentVersion,
} from "@/lib/version";
// (resolveExpectedAgentVersion is awaited per-request; it is cached so the three
// agent fields below don't each hit GitHub.)
import type { Server } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Local enums                                                         */
/* ------------------------------------------------------------------ */

// These two unions back the Server DTO but are not shared across modules,
// so they live locally here rather than in enums.ts (exported nothing).
const ServerStatusEnum = builder.enumType("ServerStatus", {
  values: ["online", "offline", "provisioning", "error"] as const,
});

const ServerTypeEnum = builder.enumType("ServerType", {
  values: ["remote"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const ServerRef = builder.objectRef<Server>("Server").implement({
  description: "A connected host running deployments (reached via its agent).",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    host: t.exposeString("host"),
    type: t.field({ type: ServerTypeEnum, resolve: (s) => s.type }),
    status: t.field({ type: ServerStatusEnum, resolve: (s) => s.status }),
    ip: t.exposeString("ip"),
    dockerVersion: t.exposeString("dockerVersion"),
    traefikEnabled: t.exposeBoolean("traefikEnabled"),
    cpuCores: t.exposeInt("cpuCores"),
    memoryMb: t.exposeInt("memoryMb"),
    diskGb: t.exposeInt("diskGb"),
    // Live-ish metrics, 0-100.
    cpuUsage: t.exposeInt("cpuUsage"),
    memoryUsage: t.exposeInt("memoryUsage"),
    diskUsage: t.exposeInt("diskUsage"),
    createdAt: t.exposeString("createdAt"),
    allTeams: t.exposeBoolean("allTeams", {
      description:
        "True (the default) when every team may target this server. False restricts it to `teams` (Settings → Servers → Team access).",
    }),
    teams: t.field({
      type: [TeamRef],
      // The granted-team NAMES are cross-team info, so gate them to infra
      // managers (the only ones who edit access) — `allTeams` above stays
      // readable by all for the count-only badge. No client selects this field
      // without the capability today.
      authScopes: { capability: "manage_infra" },
      description:
        "Teams explicitly granted access when `allTeams` is false (empty otherwise — every team has access). Requires manage_infra.",
      resolve: (s) => getServerTeams(s.id),
    }),
    // Part B: provisioning/trust state, all nullable (absent on a
    // not-yet-provisioned server). Never expose secret-shaped material — only
    // the agent VERSION + a "is it provisioned" signal + the heartbeat cache.
    provisioned: t.boolean({
      description: "True once the server's agent has called home and been trusted.",
      resolve: (s) => Boolean(s.agent?.certFingerprint),
    }),
    agentPort: t.int({
      nullable: true,
      resolve: (s) => s.agent?.port ?? null,
    }),
    agentVersion: t.string({
      nullable: true,
      description:
        "The agent binary version last reported by this server on its last Hello. Null until the server's agent has called home and been provisioned.",
      resolve: (s) => reportedAgentVersion(s),
    }),
    expectedAgentVersion: t.string({
      description:
        "The agent version this server should be running — the latest GitHub release of the agent (DeploCloud/deplo-agent). Resolved at request time and cached; falls back to a built-in version when GitHub is unreachable.",
      resolve: () => resolveExpectedAgentVersion(),
    }),
    agentOutdated: t.boolean({
      description:
        "True when this server's reported agent version is strictly older than expectedAgentVersion. False for an unseen agent or a non-semver/dev version we can't confidently compare.",
      resolve: async (s) => {
        const expected = await resolveExpectedAgentVersion();
        return isAgentOutdated(reportedAgentVersion(s), expected);
      },
    }),
    lastSeenAt: t.string({
      nullable: true,
      description: "Heartbeat cache (P5) — a hint, not the source of truth.",
      resolve: (s) => s.lastSeenAt ?? null,
    }),
  }),
});

/**
 * The result of registering a remote server: the new row PLUS the one-time
 * install command the operator pastes on the box (P1). The command embeds a
 * single-use bootstrap token, so it is returned ONCE here and never re-readable
 * (the control plane stores only its hash). Re-mint with `reissueBootstrap`.
 */
interface AddServerPayload {
  server: Server;
  installCommand: string;
}

const AddServerPayloadRef = builder
  .objectRef<AddServerPayload>("AddServerPayload")
  .implement({
    description: "A newly registered server + its one-time agent install command.",
    fields: (t) => ({
      server: t.field({ type: ServerRef, resolve: (p) => p.server }),
      installCommand: t.exposeString("installCommand", {
        description:
          "Paste-on-the-server command to provision the agent. Shown once; embeds a single-use token.",
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const AddServerInputType = builder.inputType("AddServerInput", {
  description:
    "Register a remote server. Provisioned by a call-home bootstrap (no SSH-in): you run the returned install command on the box.",
  fields: (t) => ({
    name: t.string({ required: true }),
    host: t.string({ required: true }),
    // Team access at registration. Omit / true → all teams. false + teamIds →
    // restrict to those teams (editable later via setServerTeams).
    allTeams: t.boolean({ required: false }),
    teamIds: t.stringList({ required: false }),
  }),
});

const SetServerTeamsInputType = builder.inputType("SetServerTeamsInput", {
  description:
    "Set which teams may target a server. allTeams: true opens it to every team (clearing specific grants); false restricts it to teamIds.",
  fields: (t) => ({
    serverId: t.string({ required: true }),
    allTeams: t.boolean({ required: true }),
    teamIds: t.stringList({ required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  servers: t.field({
    type: [ServerRef],
    authScopes: { loggedIn: true },
    description: "All servers, by creation order.",
    resolve: () => listServers(),
  }),
  server: t.field({
    type: ServerRef,
    nullable: true,
    authScopes: { loggedIn: true },
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getServer(id),
  }),
  primaryServer: t.field({
    type: ServerRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description:
      "The first server available, or null when none has been added/provisioned yet.",
    resolve: () => getPrimaryServer(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every server action)                                     */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  addServer: t.field({
    type: AddServerPayloadRef,
    authScopes: { instanceAdmin: true },
    args: { input: t.arg({ type: AddServerInputType, required: true }) },
    resolve: (_r, { input }) =>
      addServer({
        name: input.name,
        host: input.host,
        allTeams: input.allTeams ?? undefined,
        teamIds: input.teamIds ?? undefined,
      }),
  }),
  setServerTeams: t.field({
    type: ServerRef,
    authScopes: { instanceAdmin: true },
    description:
      "Set a server's team access. allTeams: true makes it available to every team; false restricts it to teamIds. Blocked (clear error) when a team that still has projects or databases on the server would lose access.",
    args: { input: t.arg({ type: SetServerTeamsInputType, required: true }) },
    resolve: (_r, { input }) =>
      setServerTeams(input.serverId, {
        allTeams: input.allTeams,
        teamIds: input.teamIds ?? [],
      }),
  }),
  reissueServerBootstrap: t.field({
    type: AddServerPayloadRef,
    authScopes: { instanceAdmin: true },
    description:
      "Mint a fresh install command for a server still provisioning (the original token expired or was lost).",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => reissueBootstrap(id),
  }),
  removeServer: t.field({
    type: "String",
    nullable: true,
    authScopes: { instanceAdmin: true },
    description:
      "Disconnect and remove a remote server (revokes trust, best-effort teardown). Returns a warning string if the agent was unreachable, else null.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      const { warning } = await removeServer(id);
      return warning;
    },
  }),
  updateServerAgent: t.field({
    type: "String",
    authScopes: { instanceAdmin: true },
    description:
      "Update this server's agent binary in place to the latest released version WITHOUT reissuing its certificates — the agent self-updates over its existing pinned-mTLS channel and re-execs keeping the same on-disk trust materials, so the server stays online with the same identity. Returns the version the agent is now running. Errors clearly when the server is unreachable/unprovisioned, or — until the agent ships the self-update RPC — when its agent is too old to update itself remotely (re-run the installer to upgrade it for now).",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      const { version } = await updateServerAgent(id);
      return version;
    },
  }),
  checkAgentUpdates: t.field({
    type: "String",
    authScopes: { instanceAdmin: true },
    description:
      "Force an immediate re-resolution of the latest agent release from GitHub, bypassing the in-process cache. Returns the resolved expected agent version so the dashboard re-renders with fresh outdated badges. Use after publishing a new agent release rather than waiting out the cache TTL.",
    resolve: async () => {
      // Bust the in-process memo, then re-resolve through the standard helper so
      // the fallback rule (GitHub unreachable -> FALLBACK_AGENT_VERSION) stays in
      // one place. resolveExpectedAgentVersion re-populates the memo, so the
      // RSC re-render that follows reuses this fresh value.
      const { refreshAgentRelease } = await import("@/lib/agent/release");
      await refreshAgentRelease();
      return resolveExpectedAgentVersion();
    },
  }),
}));
