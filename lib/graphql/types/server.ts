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
  setServerDeployConcurrency,
  type ServerRemoval,
} from "@/lib/data/servers";
import { checkServerHealth, checkAllServerHealth } from "@/lib/data/server-health";
import { checkServerReadiness } from "@/lib/data/server-readiness";
import {
  isAgentOutdated,
  reportedAgentVersion,
  resolveExpectedAgentVersion,
} from "@/lib/version";
// (resolveExpectedAgentVersion is awaited per-request; it is cached so the three
// agent fields below don't each hit GitHub.)
import type { ReadinessCheck, ReadinessReport } from "@/lib/infra/server-readiness";
import type { Server } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Local enums                                                         */
/* ------------------------------------------------------------------ */

// These two unions back the Server DTO but are not shared across modules,
// so they live locally here rather than in enums.ts (exported nothing).
// `warning` is NOT optional here: the health prober persists it, and an enum that
// doesn't know the value makes every `servers { status }` query fail at serialization.
const ServerStatusEnum = builder.enumType("ServerStatus", {
  values: ["online", "warning", "error", "offline", "provisioning"] as const,
});

const ServerTypeEnum = builder.enumType("ServerType", {
  values: ["remote"] as const,
});

// Readiness is a live, never-persisted REPORT, not a sixth ServerStatus: its enums describe
// one row's weight and one report's overall answer, and nothing gates on either.
const ServerReadinessSeverityEnum = builder.enumType("ServerReadinessSeverity", {
  description:
    "How much a readiness row matters. fail = a deployment to this server cannot succeed. warn = a deployment succeeds, but the result is not fully usable. info = a true, neutral fact. pass = verified good. skip = we could not evaluate it (the agent is too old, or an upstream fact is missing) — a skip never moves the verdict.",
  values: ["pass", "info", "warn", "fail", "skip"] as const,
});

const ServerReadinessGroupEnum = builder.enumType("ServerReadinessGroup", {
  values: ["agent", "docker", "routing", "capacity", "build", "config"] as const,
});

const ServerReadinessVerdictEnum = builder.enumType("ServerReadinessVerdict", {
  description:
    "The report's overall answer. provisioning = no agent has called home yet (never dialed). A `fail` row outranks `provisioning`.",
  values: ["ready", "degraded", "not_ready", "provisioning"] as const,
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
    deployConcurrency: t.exposeInt("deployConcurrency", {
      description:
        "How many deployments this server runs at once (default 1 = strict per-server serialization). Deploys on other servers run in parallel; a same-app deploy never overlaps regardless. Editable via setServerDeployConcurrency (instance-admin).",
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
    statusCheckedAt: t.string({
      nullable: true,
      description:
        "When `status` was last OBSERVED by a live agent Hello probe (ISO), or null if it never has been. Read it WITH `status`: the pair is a timestamped observation, not a standing claim, and a client that shows the status without qualifying its age is showing a value that may be hours old. Never fabricated — a probe that times out or is throttled writes nothing.",
      resolve: (s) => s.statusCheckedAt ?? null,
    }),
    statusMessage: t.string({
      nullable: true,
      // Instance-admin only, like `teams` above is manage_infra only. The strings are
      // curated (never a raw agent error), but they describe the internal state of
      // shared infrastructure and belong to the operator who administers it, not to
      // every member who can merely target the server.
      authScopes: { instanceAdmin: true },
      description:
        "Why `status` is not `online` — e.g. \"The agent is up but Docker is unreachable\". Null when online or never probed. Requires instanceAdmin.",
      resolve: (s) => s.statusMessage ?? null,
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

const ServerRemovalRef = builder
  .objectRef<ServerRemoval>("ServerRemoval")
  .implement({
    description:
      "The result of removing a server. Removal revokes the agent's trust and forgets the row — it does NOT uninstall anything on the host, so the uninstall command is always returned.",
    fields: (t) => ({
      uninstallCommand: t.exposeString("uninstallCommand", {
        description:
          "Paste-on-the-server command that removes the agent, Traefik and the deplo network from the host. Deplo cannot do this remotely: revoking trust is precisely what ends its right to command that agent.",
      }),
      warning: t.exposeString("warning", {
        nullable: true,
        description:
          "A non-blocking hazard the operator must know about (e.g. an App was mid-move off this host, so its data volumes are now stranded there), or null.",
      }),
    }),
  });

const ServerReadinessCheckRef = builder
  .objectRef<ReadinessCheck>("ServerReadinessCheck")
  .implement({
    description:
      "One row of a server readiness report: a single thing Deplo could verify about the host, and what it found.",
    fields: (t) => ({
      // A String, not an enum: the ids contain dots ("build.nixpacks").
      id: t.exposeString("id", {
        description: 'Stable row id, e.g. "docker.available" or "build.nixpacks".',
      }),
      group: t.field({ type: ServerReadinessGroupEnum, resolve: (c) => c.group }),
      label: t.exposeString("label"),
      severity: t.field({ type: ServerReadinessSeverityEnum, resolve: (c) => c.severity }),
      detail: t.exposeString("detail", {
        description:
          "What we found. Drawn from a closed, curated set whenever it describes a failure — never a raw agent error (which would leak the pinned certificate fingerprint and the dial address).",
      }),
      hint: t.string({
        nullable: true,
        description: "What to do about it. Null on a `pass` row.",
        resolve: (c) => c.hint ?? null,
      }),
    }),
  });

const ServerReadinessReportRef = builder
  .objectRef<ReadinessReport>("ServerReadinessReport")
  .implement({
    description:
      "A live, never-persisted answer to 'is this host set up to run deployments?'. Assembled from one agent Hello, two host port bind-tests and one host-metrics call, plus the control plane's own record of the server. It is NOT a sixth ServerStatus and nothing gates on it — the deploy gate is and stays the mandatory live Hello pre-flight.",
    fields: (t) => ({
      serverId: t.exposeString("serverId"),
      serverName: t.exposeString("serverName"),
      checkedAt: t.exposeString("checkedAt", {
        description: "When the probe STARTED (ISO). Never fabricated.",
      }),
      verdict: t.field({ type: ServerReadinessVerdictEnum, resolve: (r) => r.verdict }),
      summary: t.exposeString("summary", { description: "One sentence for the banner." }),
      checks: t.field({ type: [ServerReadinessCheckRef], resolve: (r) => r.checks }),
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
  reissueServerBootstrap: t.field({
    type: AddServerPayloadRef,
    authScopes: { instanceAdmin: true },
    description:
      "Mint a fresh install command for a server still provisioning (the original token expired or was lost).",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => reissueBootstrap(id),
  }),
  removeServer: t.field({
    type: ServerRemovalRef,
    authScopes: { instanceAdmin: true },
    description:
      "Remove a server: revoke its agent's trust and forget the row. This does NOT uninstall anything on the host — the agent, Traefik and the deplo network keep running there — so the returned payload always carries the host-side uninstall command. Blocked while any App or database still lives on the server.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => removeServer(id),
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
  // Health checks are MUTATIONS, not queries, even though they read. They dial out
  // over the network and write the row — and app/api/graphql/route.ts serves GET, so a
  // side-effecting query would be reachable by a plain link (prefetch, crawler, CSRF)
  // and would turn the control plane into a fan-out dialer on someone else's click.
  // Neither takes a host/port: only an opaque serverId, resolved through the pinned
  // dial target, so this can never be pointed at an arbitrary address.
  checkServerHealth: t.field({
    type: ServerRef,
    authScopes: { instanceAdmin: true },
    description:
      "Probe ONE server's agent right now (a live Hello) and persist what it reports: online, warning (agent up, Docker unreachable), error (agent untrusted or broken) or offline. Returns the refreshed server. Throttled server-side even when forced, so it cannot be used to hammer a host; an inconclusive probe leaves the previous observation untouched rather than guessing.",
    args: {
      id: t.arg.string({ required: true }),
      force: t.arg.boolean({
        required: false,
        description:
          "Bypass the ambient throttle (the operator asked for this check explicitly). A short floor still applies.",
      }),
    },
    resolve: (_r, { id, force }) => checkServerHealth(id, { force: force ?? false }),
  }),
  checkAllServerHealth: t.field({
    type: [ServerRef],
    authScopes: { instanceAdmin: true },
    description:
      "Probe every provisioned server's agent and persist each outcome; returns every server (unprovisioned ones pass through untouched). This is what the Servers page runs on load, so a reload always reflects reality rather than the status a server had when it first called home.",
    args: {
      force: t.arg.boolean({
        required: false,
        description: "Bypass the ambient throttle (the header's 'Check all' button).",
      }),
    },
    resolve: (_r, { force }) => checkAllServerHealth({ force: force ?? false }),
  }),
  // A MUTATION, not a query, for exactly the reason checkServerHealth above is one: it dials
  // out over the network, and app/api/graphql/route.ts serves GET — a side-effecting query
  // would be reachable by a plain link (prefetch, crawler, CSRF) and would turn the control
  // plane into a fan-out dialer on someone else's click. It takes an opaque serverId, resolved
  // through the pinned dial target, so it can never be pointed at an arbitrary address. Unlike
  // the health checks it writes NOTHING — the report is computed live and thrown away.
  checkServerReadiness: t.field({
    type: ServerReadinessReportRef,
    authScopes: { instanceAdmin: true },
    description:
      "Check whether ONE server's installation is complete enough to run deployments, right now. Dials the agent (Hello), bind-tests host ports 80 and 443, and reads host metrics, then reports what it found: the agent's handshake/protocol/version and which build methods and platform features it supports, whether Docker answers, whether a Traefik container is running and holds the web ports, disk headroom, and this server's team access and deploy concurrency. Never persisted — it does not touch `status`, so it can neither create nor cure a stale badge. Degrades honestly: an agent too old to bind-test ports reports those rows as skipped, never as a pass.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => checkServerReadiness(id),
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
