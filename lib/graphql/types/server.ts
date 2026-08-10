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
import {
  serverHostInfo,
  setServerTimezone,
  restartServerWorkloads,
  restartServerTraefik,
  restartDeploPanel,
  setServerTraefikDashboard,
  type ServerHostInfo,
  type ServerRestartReport,
  type RestartedWorkload,
} from "@/lib/data/server-maintenance";
import {
  listServerCertificates,
  addServerCertificate,
  removeServerCertificate,
  type ServerCertificate,
} from "@/lib/data/server-certificates";
import { deploHostSelfAddresses, isDeploHostServer } from "@/lib/deploy/domains";
import { refreshAgentVersion } from "@/lib/data/updates";
import { checkServerReadiness } from "@/lib/data/server-readiness";
import { reportedAgentVersion, resolveExpectedAgentVersion } from "@/lib/version";
// (resolveExpectedAgentVersion is awaited per-request; it is cached so the agent
// fields below don't each hit GitHub.)
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
      authScopes: { capability: "manage_team" },
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
    isDeploHost: t.boolean({
      description:
        "Whether this is the host running Deplo itself (the dashboard and API), as opposed to a remote that only runs the deploy agent. It cannot be removed, and it is the only server that can restart the Deplo panel.",
      resolve: (s) => isDeploHostServer(s, deploHostSelfAddresses()),
    }),
    traefikDashboardDomain: t.string({
      nullable: true,
      // Instance-admin for the same reason statusMessage is: it describes shared
      // infrastructure the operator administers, not something every member who
      // can merely deploy here needs to know the address of.
      authScopes: { instanceAdmin: true },
      description:
        "The domain this server publishes Traefik's own dashboard on, or null when it is off (the default). Requires instanceAdmin. The credentials guarding it are never readable.",
      resolve: (s) => s.traefikDashboard?.domain ?? null,
    }),
    traefikDashboardUser: t.string({
      nullable: true,
      authScopes: { instanceAdmin: true },
      description:
        "The username for the Traefik dashboard's basic auth, so the form can show whose credentials are in place. The password has no read path at all.",
      resolve: (s) => s.traefikDashboard?.username ?? null,
    }),
  }),
});

/* ------------------------------------------------------------------ */
/* Host info (what the box IS, read live from the agent)               */
/* ------------------------------------------------------------------ */

const ServerHostInfoRef = builder
  .objectRef<ServerHostInfo>("ServerHostInfo")
  .implement({
    description:
      "What a server IS — its hardware, OS and clock — read live from its agent and stored nowhere. Distinct from the usage gauges on Monitoring: this is the make and model, not the load.",
    fields: (t) => ({
      cpuModel: t.exposeString("cpuModel", {
        description:
          'The processor as it names itself, e.g. "AMD Ryzen 5 5600X 6-Core Processor". Empty when the host does not report one.',
      }),
      cpuCores: t.exposeInt("cpuCores", {
        description:
          "PHYSICAL cores. A 6-core/12-thread chip reports 6 here and 12 in cpuThreads; reporting threads as cores is the usual way a spec sheet overstates a box.",
      }),
      cpuThreads: t.exposeInt("cpuThreads", {
        description: "Logical processors — what schedulers and `nproc` count.",
      }),
      memTotalBytes: t.exposeFloat("memTotalBytes", { description: "Installed RAM, in bytes." }),
      diskTotalBytes: t.exposeFloat("diskTotalBytes", {
        description: "Size of the filesystem the agent's data lives on, in bytes.",
      }),
      diskUsedBytes: t.exposeFloat("diskUsedBytes", { description: "Used bytes on that filesystem." }),
      osPretty: t.exposeString("osPretty", {
        description: 'The distribution, e.g. "Ubuntu 24.04.1 LTS".',
      }),
      kernel: t.exposeString("kernel", { description: "Kernel release (uname -r)." }),
      arch: t.exposeString("arch", { description: 'Machine architecture, e.g. "x86_64".' }),
      dockerVersion: t.exposeString("dockerVersion", {
        description: "Docker engine version, empty when the daemon is unreachable.",
      }),
      dockerRootDir: t.exposeString("dockerRootDir", {
        description:
          "Where Docker actually keeps images and volumes — on a host with a mounted data disk this is not the root filesystem.",
      }),
      uptimeSec: t.exposeFloat("uptimeSec", { description: "Seconds since the host booted." }),
      timezone: t.exposeString("timezone", {
        description: 'The host clock\'s IANA zone, e.g. "Europe/Rome". Empty if it reports none.',
      }),
      timeUnixMs: t.exposeFloat("timeUnixMs", {
        description:
          "The host's own clock at the moment of the read (epoch ms). Compare it with controlPlaneTimeUnixMs, never with the viewer's clock, to spot a drifting box.",
      }),
      controlPlaneTimeUnixMs: t.exposeFloat("controlPlaneTimeUnixMs", {
        description:
          "Deplo's own clock when this reading landed (epoch ms). The pair with timeUnixMs is the honest drift measurement: measuring against the browser measures the browser, and a viewer whose laptop is an hour out would see the whole fleet reported as drifting.",
      }),
      utcOffsetMinutes: t.exposeInt("utcOffsetMinutes", {
        description:
          "Offset from UTC in MINUTES, not hours — Kathmandu is +345 and Kolkata +330.",
      }),
      traefikManaged: t.exposeBoolean("traefikManaged", {
        description:
          "Whether Deplo installed the Traefik on this host. False for a server behind the operator's own proxy, where Deplo will not reconfigure anything — the dashboard cannot be published there.",
      }),
      traefikDashboardDomain: t.string({
        nullable: true,
        description:
          "The domain the host is CURRENTLY serving Traefik's dashboard on, read from the live stack file rather than from what Deplo stored — so a host reconfigured out of band reports the truth.",
        resolve: (i) => i.traefikDashboardDomain,
      }),
      canRestartControlPlane: t.exposeBoolean("canRestartControlPlane", {
        description:
          "Whether the Deplo panel runs in a container on this host that the agent could restart. False when Deplo was started some other way, in which case the restart action is not offered.",
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Whole-server restart report                                         */
/* ------------------------------------------------------------------ */

const RestartedWorkloadRef = builder
  .objectRef<RestartedWorkload>("RestartedWorkload")
  .implement({
    description: "One workload that could not be restarted, and why.",
    fields: (t) => ({
      kind: t.exposeString("kind", { description: '"app" or "database".' }),
      name: t.exposeString("name"),
      error: t.string({
        nullable: true,
        description: "The failure, verbatim from the host.",
        resolve: (w) => w.error,
      }),
    }),
  });

const ServerRestartReportRef = builder
  .objectRef<ServerRestartReport>("ServerRestartReport")
  .implement({
    description:
      "The outcome of restarting everything Deplo runs on a server. Partial success is normal and is reported as such — one wedged stack must not hide that the other twenty came back.",
    fields: (t) => ({
      restarted: t.exposeInt("restarted"),
      skipped: t.exposeInt("skipped", {
        description:
          "Workloads left alone: the ones already stopped (starting them is a different action than restarting them) and the ones with a deploy in flight, which come back on their own.",
      }),
      failures: t.field({
        type: [RestartedWorkloadRef],
        resolve: (r) => r.failures,
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
    // A server that only holds backups: the install command skips Docker and
    // Traefik, and the readiness/health checks stop expecting them.
    storageOnly: t.boolean({ required: false }),
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

const TraefikDashboardInputType = builder.inputType("TraefikDashboardInput", {
  description:
    "Where to publish Traefik's dashboard and who may open it. Credentials are not optional: the dashboard exposes every router, service and certificate on the host.",
  fields: (t) => ({
    domain: t.string({
      required: true,
      description: "The host the dashboard answers on. Point its DNS at this server first.",
    }),
    username: t.string({ required: true, description: "Basic-auth username. No colons." }),
    password: t.string({
      required: false,
      description:
        "Basic-auth password. Required the first time the dashboard is turned on; omit it on a later edit to keep the stored one. It can never be read back.",
    }),
  }),
});

/* ------------------------------------------------------------------ */
/* Custom certificates                                                 */
/* ------------------------------------------------------------------ */

const ServerCertificateRef = builder
  .objectRef<ServerCertificate>("ServerCertificate")
  .implement({
    description:
      "A TLS certificate the operator installed on a server themselves, described from the certificate itself. It lives in that host's proxy and nowhere else (Deplo stores no copy), and its private key has no read path at all.",
    fields: (t) => ({
      id: t.exposeString("id", {
        description:
          "The certificate's SHA-256 fingerprint, which is also how it is addressed for removal. Nothing is minted: a certificate identifies itself.",
      }),
      subject: t.exposeString("subject", {
        description: "Its common name, or its first domain when it carries none.",
      }),
      domains: t.exposeStringList("domains", {
        description:
          "Every hostname this certificate is valid for. Traefik picks a certificate by the domain the browser asked for, so these are the domains it will serve on this host.",
      }),
      issuer: t.exposeString("issuer", { description: "Who signed it." }),
      notBefore: t.exposeString("notBefore", { description: "Valid from (ISO-8601)." }),
      notAfter: t.exposeString("notAfter", { description: "Expires at (ISO-8601)." }),
      expired: t.exposeBoolean("expired", {
        description:
          "Whether it is already past its expiry. A certificate can lapse in place long after it was installed, so this is computed, not stored.",
      }),
      expiresInDays: t.exposeInt("expiresInDays", {
        description:
          "Whole days left before it expires, negative once it has. Nothing renews these, so the only warning is this number.",
      }),
    }),
  });

const ServerCertificateInputType = builder.inputType("ServerCertificateInput", {
  description: "A certificate and the private key it was issued for, as PEM text.",
  fields: (t) => ({
    certificate: t.string({
      required: true,
      description:
        "The certificate in PEM form. Paste the FULL chain: the certificate followed by any intermediates, which browsers need.",
    }),
    privateKey: t.string({
      required: true,
      description:
        "The matching private key in PEM form, without a passphrase. It is sent to the server and is never readable afterwards.",
    }),
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
        storageOnly: input.storageOnly ?? undefined,
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
  // ---- Host ops. Like the two health checks above, checkServerHostInfo is a
  // MUTATION despite writing nothing: it dials out over the network, and
  // app/api/graphql/route.ts serves GET, so a side-effecting query would be
  // reachable by a plain link (prefetch, crawler, CSRF) and would turn the
  // control plane into a fan-out dialer on someone else's click. Each takes an
  // opaque serverId resolved through the pinned dial target, never an address.
  checkServerHostInfo: t.field({
    type: ServerHostInfoRef,
    authScopes: { instanceAdmin: true },
    description:
      "Read what this server IS, right now: CPU model and core count, installed RAM, disk, distribution, kernel, architecture, Docker version and data root, uptime, and the host's own clock and timezone. Also reports whether Deplo manages the Traefik here and whether the Deplo panel runs in a container the agent could restart. Persists nothing. Errors clearly when the agent is unreachable or too old for host management.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => serverHostInfo(id),
  }),
  setServerTimezone: t.field({
    type: ServerHostInfoRef,
    authScopes: { instanceAdmin: true },
    description:
      'Set the host clock\'s timezone to an IANA zone name (e.g. "Europe/Rome"). Changes the wall-clock LABEL, not the instant: nothing restarts, and Deplo\'s own schedules (backups, cleanup) stay on UTC. Aliases are accepted and canonicalised ("US/Eastern" is stored as "America/New_York"); a bare UTC offset is not a zone and is refused. Returns a fresh reading of the host, so the moved clock is visible without a second call. The agent rejects a zone the host does not carry.',
    args: {
      id: t.arg.string({ required: true }),
      timezone: t.arg.string({ required: true }),
    },
    resolve: (_r, { id, timezone }) => setServerTimezone(id, timezone),
  }),
  restartServerWorkloads: t.field({
    type: ServerRestartReportRef,
    authScopes: { instanceAdmin: true },
    description:
      "Restart every App and database Deplo runs on this server, one at a time. Containers Deplo did not deploy are never touched. Workloads that are already stopped are skipped rather than started (restarting and starting are different actions), as are workloads with a deploy in flight, which come back on their own. An App whose last deploy FAILED is restarted, not skipped: a failed deploy usually leaves the previous stack serving. Reports per-workload failures instead of stopping at the first one, and says explicitly when a workload stopped but did not start again.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => restartServerWorkloads(id),
  }),
  restartServerTraefik: t.field({
    type: "Boolean",
    authScopes: { instanceAdmin: true },
    description:
      "Restart the Traefik reverse proxy on this server. The configuration is untouched — this is the 'it is wedged, bounce it' action. Routing on this host is interrupted for the few seconds Traefik takes to come back. Errors when Deplo did not install Traefik there.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await restartServerTraefik(id);
      return true;
    },
  }),
  restartDeploPanel: t.field({
    type: "Boolean",
    authScopes: { instanceAdmin: true },
    description:
      "Restart the Deplo control plane on the host that runs it. Refused for any other server. Returns once the restart is SCHEDULED, not once it is done: the restart ends the process serving this request, so the answer necessarily arrives first — expect the dashboard to be briefly unreachable.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await restartDeploPanel(id);
      return true;
    },
  }),
  setServerTraefikDashboard: t.field({
    type: ServerRef,
    authScopes: { instanceAdmin: true },
    description:
      "Publish Traefik's own web dashboard for this server on a domain, protected by basic auth, or turn it off by passing no input. A domain, a username and a password are ALL required to enable it — the dashboard lists every route, service and certificate on the host, so it is never published unprotected. On an edit that only changes the domain the stored password is reused; the password itself can never be read back. Applying the change recreates the Traefik container, so routing on this host is interrupted for a few seconds.",
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: TraefikDashboardInputType, required: false }),
    },
    resolve: async (_r, { id, input }) => {
      await setServerTraefikDashboard(
        id,
        input
          ? {
              domain: input.domain,
              username: input.username,
              password: input.password ?? "",
            }
          : null,
      );
      return (await getServer(id))!;
    },
  }),
  // A MUTATION for the same reason checkServerHostInfo is one: it dials the host
  // over the network, and the GraphQL route serves GET.
  serverCertificates: t.field({
    type: [ServerCertificateRef],
    authScopes: { instanceAdmin: true },
    description:
      "List the TLS certificates installed on this server by hand, read live from its proxy. Deplo keeps no copy of them, so this is what the host is actually serving. Errors when Deplo did not install the proxy there.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => listServerCertificates(id),
  }),
  addServerCertificate: t.field({
    type: [ServerCertificateRef],
    authScopes: { instanceAdmin: true },
    description:
      "Install a TLS certificate on this server. The certificate and its key are checked as a pair before the host is touched: a key that does not match, or a certificate that has already expired, is refused. The proxy then serves it for every domain named in it, taking precedence over Let's Encrypt, which stops issuing for domains a certificate already covers. Uploading one for the same domains replaces it. Applying recreates the proxy, so routing on this host is interrupted for a few seconds. Returns the certificates installed afterwards.",
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: ServerCertificateInputType, required: true }),
    },
    resolve: (_r, { id, input }) =>
      addServerCertificate(id, {
        certPem: input.certificate,
        keyPem: input.privateKey,
      }),
  }),
  removeServerCertificate: t.field({
    type: [ServerCertificateRef],
    authScopes: { instanceAdmin: true },
    description:
      "Remove a certificate from this server by its fingerprint. Its domains fall back to whatever else covers them, usually Let's Encrypt, which issues for them again once the proxy comes back. Recreates the proxy, so routing on this host blips.",
    args: {
      id: t.arg.string({ required: true }),
      certificateId: t.arg.string({ required: true }),
    },
    resolve: (_r, { id, certificateId }) => removeServerCertificate(id, certificateId),
  }),
  checkAgentUpdates: t.field({
    type: "String",
    authScopes: { instanceAdmin: true },
    description:
      "Force an immediate re-resolution of the latest agent release from GitHub, bypassing the in-process cache. Returns the resolved expected agent version so the dashboard re-renders with fresh outdated badges. Use after publishing a new agent release rather than waiting out the cache TTL.",
    resolve: () => refreshAgentVersion(),
  }),
}));
