import {
  FAILOVER_MIN_MEMBERS,
  type ClusterImageProgress,
  type ClusterLeader,
} from "@/lib/types/cluster";

/** One banner above a cluster's servers, as an App's page shows them. */
export type ClusterWarning = {
  key: string;
  title: string;
  body: string;
  /** The leader stopped where Deplo can start it again. */
  startLeader?: boolean;
  /** Cloudflare refuses the panel's API token: a new one fixes it. */
  fixCloudflareToken?: boolean;
};

const NOT_WORKING = "Failover is not working right now";
const MAY_STOP = "Failover may stop working";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What the leader says is wrong: asked of its server, so Deplo works it out in the background. */
export function leaderWarnings(leader: ClusterLeader | null): ClusterWarning[] {
  const out: ClusterWarning[] = [];
  if (!leader)
    out.push({
      key: "leader",
      title: NOT_WORKING,
      body: "Deplo could not read the cluster's leader.",
    });
  else if (leader.state !== "running")
    out.push({
      key: "leader",
      title: NOT_WORKING,
      body: leader.message || "The cluster's leader is not running.",
      startLeader: ["stopped", "not_installed", "unreachable"].includes(
        leader.state,
      ),
    });
  else if (leader.failoverReady === false)
    out.push({ key: "leader", title: NOT_WORKING, body: leader.message });
  if (leader?.takenOverAt)
    out.push({
      key: "takeover",
      title: "Deplo's own machine leads this cluster",
      body: `Until ${leader.serverName} ${leader.state === "outdated" ? "is updated" : "answers again"}.`,
    });
  for (const [key, body] of [
    ["update", leader?.updateMessage],
    ["relay", leader?.relayMessage],
    ["own-server", leader?.ownServerWarning],
  ] as const)
    if (body)
      out.push({
        key,
        title: MAY_STOP,
        body,
        ...(key === "relay" && leader?.relayNeedsToken
          ? { fixCloudflareToken: true }
          : {}),
      });
  return out;
}

/**
 * Every banner, in order: Apps left waiting always, failover's trouble only while it is on. `leader` is
 * what the background check stored, so nothing here asks a server.
 */
export function composeClusterWarnings(input: {
  failoverEnabled: boolean;
  servers: number;
  leader: ClusterWarning[];
  waiting: string[];
  copies: ClusterImageProgress[];
}): ClusterWarning[] {
  const out: ClusterWarning[] = [];
  if (input.waiting.length > 0)
    out.push({
      key: "waiting",
      title: `${plural(input.waiting.length, "App")} waiting for room`,
      body: `${input.waiting.join(", ")}. Deplo tries again every 30 seconds.`,
    });
  if (!input.failoverEnabled || input.servers === 0) return out;
  if (input.servers < FAILOVER_MIN_MEMBERS) {
    out.push({
      key: "one-server",
      title: "Failover needs a second server",
      body: "With one server there is nowhere to move an App to. Drag another server onto this cluster.",
    });
    return out;
  }
  out.push(...input.leader);
  if (input.copies.length > 0)
    out.push({
      key: "copies",
      title: `Failover is not ready for ${plural(input.copies.length, "App")} yet`,
      body: `Their latest version is still being copied: ${input.copies
        .map((c) => `${c.appName} on ${c.held} of ${c.total} servers`)
        .join(", ")}.`,
    });
  return out;
}

/** The same banners from a live leader read. */
export function clusterWarnings(input: {
  failoverEnabled: boolean;
  servers: number;
  /** Null when Deplo could not read it. */
  leader: ClusterLeader | null;
  waiting: string[];
  copies: ClusterImageProgress[];
}): ClusterWarning[] {
  return composeClusterWarnings({
    ...input,
    leader: leaderWarnings(input.leader),
  });
}
