import { builder } from "../../builder";
import { TeamRef } from "../team";
import { serverRole } from "@/lib/data/servers/roster";
import { getServerTeams } from "@/lib/data/servers/team-access";
import {
  deploHostSelfAddresses,
  isBuildFallbackServer,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import { reportedAgentVersion } from "@/lib/version";
import { expectedAgentVersionFor } from "@/lib/agent/release";
import type { Server } from "@/lib/types/server";

export const ServerStatusEnum = builder.enumType("ServerStatus", {
  values: ["online", "warning", "error", "offline", "provisioning"] as const,
});

const ServerTypeEnum = builder.enumType("ServerType", {
  values: ["remote"] as const,
});

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
    createdAt: t.exposeString("createdAt"),
    allTeams: t.exposeBoolean("allTeams", {
      description:
        "True (the default) when every team may target this server. False restricts it to `teams` (Settings → Servers → Team access).",
    }),
    deployConcurrency: t.exposeInt("deployConcurrency", {
      description:
        "How many deployments this server runs at once (default 1 = strict per-server serialization). Deploys on other servers run in parallel; a same-app deploy never overlaps regardless. Editable via setServerDeployConcurrency (instance-admin). With a build server, the lane belongs to the BUILDER - that is where a deploy's cost is.",
    }),
    role: t.string({
      description:
        'What this server is for: "everything" (the default), "build" (Docker but no proxy; it compiles for other hosts and runs nothing), "storage" (no Docker; it only holds backups) or "import" (a MIGRATION SOURCE: another platform\'s host, registered by the import wizard to read its volumes, out of every deploy and build picker and swept by nothing). Only the build axis is changeable after installation; "import" is refused by setServerRole in both directions.',
      resolve: (s) => serverRole(s),
    }),
    uninstallPending: t.exposeBoolean("uninstallPending", {
      description:
        "Deplo is still trying to take its agent off this migration source, and will try again on its own. Nothing is asked of anyone while this is true. False for every other server.",
    }),
    uninstallError: t.exposeString("uninstallError", {
      description:
        "Why Deplo could not take its agent off this migration source, after it stopped trying (three attempts over several minutes). Empty otherwise. This is the only state that needs a person: surface it verbatim next to the host-side uninstall command.",
    }),
    hostArch: t.exposeString("hostArch", {
      description:
        'This host\'s CPU architecture ("amd64" | "arm64"), observed from the agent. Empty when the agent is too old to report it. A build server can only build for a host of the SAME architecture.',
    }),
    buildFallback: t.boolean({
      description:
        "Whether this host compiles for an app whose own build server could not be reached. On by default for the Deplo host and off for every other server, until setServerBuildFallback says otherwise. An app opts out of the whole chain with setAppBuildServer's buildFallback.",
      resolve: (s) => isBuildFallbackServer(s, deploHostSelfAddresses()),
    }),
    teams: t.field({
      type: [TeamRef],
      authScopes: { capability: "manage_team" },
      description:
        "Teams explicitly granted access when `allTeams` is false (empty otherwise - every team has access). Requires manage_infra.",
      resolve: (s) => getServerTeams(s.id),
    }),
    provisioned: t.boolean({
      description:
        "True once the server's agent has called home and been trusted.",
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
        "The agent version this server should be running - the latest GitHub release of the agent (DeploCloud/deplo-agent), or the newest canary when `agentCanary` is on. Resolved at request time and cached; falls back to a built-in version when GitHub is unreachable.",
      resolve: (s) => expectedAgentVersionFor(s),
    }),
    agentCanary: t.exposeBoolean("agentCanary", {
      description:
        "Whether this server is offered canary (pre-release) agent versions as updates. Nothing installs one on its own: the update stays a click. Set with setServerAgentCanary.",
    }),
    lastSeenAt: t.string({
      nullable: true,
      description: "Heartbeat cache (P5) - a hint, not the source of truth.",
      resolve: (s) => s.lastSeenAt ?? null,
    }),
    statusCheckedAt: t.string({
      nullable: true,
      description:
        "When `status` was last OBSERVED by a live agent Hello probe (ISO), or null if it never has been. Read it WITH `status`: the pair is a timestamped observation, not a standing claim, and a client that shows the status without qualifying its age is showing a value that may be hours old. Never fabricated - a probe that times out or is throttled writes nothing.",
      resolve: (s) => s.statusCheckedAt ?? null,
    }),
    statusMessage: t.string({
      nullable: true,
      authScopes: { instanceAdmin: true },
      description:
        'Why `status` is not `online` - e.g. "The agent is up but Docker is unreachable". Null when online or never probed. Requires instanceAdmin.',
      resolve: (s) => s.statusMessage ?? null,
    }),
    isDeploHost: t.boolean({
      description:
        "Whether this is the host running Deplo itself (the dashboard and API), as opposed to a remote that only runs the deploy agent. It cannot be removed, and it is the only server that can restart the Deplo panel.",
      resolve: (s) => isDeploHostServer(s, deploHostSelfAddresses()),
    }),
  }),
});
