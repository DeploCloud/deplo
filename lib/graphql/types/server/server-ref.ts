import { builder } from "../../builder";
import { TeamRef } from "../team";
import { serverRole } from "@/lib/data/servers/roster";
import { getServerTeams } from "@/lib/data/servers/team-access";
import {
  deploHostSelfAddresses,
  isBuildFallbackServer,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import { serverAddressChoices } from "@/lib/data/servers/addresses";
import { serverAgentUpdate } from "@/lib/data/servers/agent-maintenance";
import type { AgentUpdateDTO } from "@/lib/data/servers/agent-update-state";
import { AGENT_VERSION, agentReach, reportedAgentVersion } from "@/lib/version";
import type { Server } from "@/lib/types/server";

export const ServerStatusEnum = builder.enumType("ServerStatus", {
  values: ["online", "warning", "error", "offline", "provisioning"] as const,
});

export const AddressFamilyEnum = builder.enumType("AddressFamily", {
  values: ["ipv4", "ipv6"] as const,
});

const GeneratedAddressesRef = builder
  .objectRef<{
    ipv4: string | null;
    ipv6: string | null;
    inUse: string | null;
  }>("GeneratedAddresses")
  .implement({
    description:
      "The addresses this server's generated (.deplo.site) names can carry, read live from its agent and DNS.",
    fields: (t) => ({
      ipv4: t.string({ nullable: true, resolve: (a) => a.ipv4 }),
      ipv6: t.string({ nullable: true, resolve: (a) => a.ipv6 }),
      inUse: t.string({
        nullable: true,
        description:
          "The address a name generated here right now embeds. Null when Deplo knows none.",
        resolve: (a) => a.inUse,
      }),
    }),
  });

const ServerTypeEnum = builder.enumType("ServerType", {
  values: ["remote"] as const,
});

export const AgentUpdateRef = builder
  .objectRef<AgentUpdateDTO>("ServerAgentUpdate")
  .implement({
    description:
      "Where Deplo's update of one server's agent stands. Deplo retries a failed update on its own (1, 2, 4 … up to 60 minutes apart) for 24 hours from the first failure; `retryServerAgentUpdate` tries again now.",
    fields: (t) => ({
      running: t.exposeBoolean("running", {
        description:
          "An attempt is in progress; a retry is refused until it ends.",
      }),
      failed: t.exposeBoolean("failed", {
        description:
          "At least one attempt failed. Only then can an instance admin retry by hand.",
      }),
      gaveUp: t.exposeBoolean("gaveUp", {
        description:
          "24 hours passed since the first failure: no automatic retry is scheduled.",
      }),
      attempts: t.exposeInt("attempts"),
      failure: t.exposeString("failure", {
        description:
          'Why the last attempt failed: "busy" (a deploy was running), "unreachable", "error", or "no_return" (it took the new agent and did not come back, which pauses every other server). Empty before the first failure.',
      }),
      lastError: t.exposeString("lastError"),
      firstFailedAt: t.exposeString("firstFailedAt", { nullable: true }),
      nextRetryAt: t.exposeString("nextRetryAt", { nullable: true }),
    }),
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
    generatedAddressFamily: t.field({
      type: AddressFamilyEnum,
      nullable: true,
      description:
        "Which kind of address the generated (.deplo.site) names of apps on this server carry. Null is automatic: IPv4 when the host has one, IPv6 otherwise - and on the Deplo host, whichever the installer chose. setServerAddressFamily changes it.",
      resolve: (s) => s.generatedAddressFamily,
    }),
    generatedAddresses: t.field({
      type: GeneratedAddressesRef,
      authScopes: { instanceAdmin: true },
      description:
        "Live: asks the server's agent and DNS, so select it on one server at a time. Requires instanceAdmin.",
      resolve: (s) => serverAddressChoices(s),
    }),
    teams: t.field({
      type: [TeamRef],
      authScopes: { capability: "manage_team" },
      description:
        "Teams explicitly granted access when `allTeams` is false (empty otherwise - every team has access). Only an instance admin sees every team; anyone else sees the active team at most.",
      resolve: (s) => getServerTeams(s.id),
    }),
    provisioned: t.boolean({
      description:
        "True once the server's agent has called home and been trusted.",
      resolve: (s) => Boolean(s.agent?.certFingerprint),
    }),
    agentPort: t.int({
      nullable: true,
      description: "Always null: Deplo connects to no server's agent.",
      deprecationReason:
        "Always null: every server agent links in to Deplo (ADR-0040), so Deplo connects to no port. Goes in the next release.",
      resolve: () => null,
    }),
    agentVersion: t.string({
      nullable: true,
      description:
        "The agent binary version last reported by this server on its last Hello. Null until the server's agent has called home and been provisioned.",
      resolve: (s) => reportedAgentVersion(s),
    }),
    expectedAgentVersion: t.string({
      description:
        "The agent version this server should be running: the one release of DeploCloud/deplo-agent this Deplo is pinned to. A newer agent is left alone, never downgraded.",
      resolve: () => AGENT_VERSION,
    }),
    agentUsable: t.boolean({
      description:
        "Whether this Deplo talks to the server's agent at all. False when the agent is older than the minimum this version of Deplo supports, which it updates on its own; when the server has not connected to Deplo yet, which it does by itself once it can; or when it can never connect (its agent too old to, or left behind at an update stop on a version Deplo never read), which only reinstalling its server agent fixes. Everything on the server is refused meanwhile, though its apps keep running. True while it is not provisioned yet.",
      resolve: (s) => !s.agent?.certFingerprint || agentReach(s) === "usable",
    }),
    agentUpdate: t.field({
      type: AgentUpdateRef,
      nullable: true,
      authScopes: { instanceAdmin: true },
      description:
        "Deplo's update of this server's agent, while one is in flight or has failed. Null otherwise. Requires instanceAdmin.",
      resolve: (s) => serverAgentUpdate(s.id),
    }),
    lastSeenAt: t.string({
      nullable: true,
      description: "Heartbeat cache (P5) - a hint, not the source of truth.",
      resolve: (s) => s.lastSeenAt ?? null,
    }),
    statusCheckedAt: t.string({
      nullable: true,
      description:
        "When `status` was last OBSERVED (ISO) - by a live agent Hello, or, for a server whose agent links in, by its link staying away - or null if it never has been. Read it WITH `status`: the pair is a timestamped observation, not a standing claim, and a client that shows the status without qualifying its age is showing a value that may be hours old. Never fabricated - a probe that times out or is throttled writes nothing.",
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
