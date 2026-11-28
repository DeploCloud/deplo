import type { ListView } from "@/components/shared/view-toggle";
import type { ClusterLeaseState, ClusterMember } from "@/lib/types/cluster";
import type { MemberEmptyingState } from "./cluster-member-actions";

/** What a server is doing as one of a cluster's servers. */
export type ServerMemberState = {
  /** It joined and the cluster's leader has not answered for it yet. */
  provisioning: boolean;
  leaseState: ClusterLeaseState;
  emptying: MemberEmptyingState;
  /** "2 of 5 moved, moving web"; empty when nothing is moving. */
  progress: string;
  /** Why its removal stopped; empty while it runs. */
  error: string;
  /** How many Apps and databases it holds. */
  held: number;
  /** One line when it does not reach every other server of the cluster directly; empty when it does. */
  network: string;
  /** It cannot reach one of them at all, which is worth a warning rather than a note. */
  networkDown: boolean;
  /** It stops like a power cut when Deplo's machine does: a warning icon on its row and its page; empty otherwise. */
  relayWarning: string;
  /** A copy of an App that does not fit on it: a warning icon on its row and its page; empty otherwise. */
  copyWarning: string;
  /** 1 leads the cluster next, 2 after it, 0 not in the line. */
  nextInLine: number;
};

/** "eu-2" and "deplo and eu-2": the servers one reaches a certain way, for a card's line. */
export function serverList(names: string[]): string {
  const sorted = [...new Set(names)].sort();
  if (sorted.length <= 1) return sorted.join("");
  return `${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
}

/** "Reaches eu-2 through Deplo's relay": how a server's private network stands, when it is not all direct. */
export function networkLine(n: ClusterMember["network"]): string {
  const parts = [
    n.unreachable.length > 0 && `Cannot reach ${serverList(n.unreachable)} now`,
    n.relayed.length > 0 &&
      `Reaches ${serverList(n.relayed)} through Deplo's relay, with more delay`,
  ].filter(Boolean);
  return parts.join(". ");
}

export function memberState(m: ClusterMember): ServerMemberState {
  const e = m.emptying;
  return {
    provisioning: m.provisioning,
    leaseState: m.leaseState,
    emptying: !e ? "idle" : e.error ? "stopped" : "removing",
    progress:
      e && e.total > 0
        ? `${e.total - e.left} of ${e.total} moved${e.moving ? `, moving ${e.moving}` : ""}`
        : "",
    error: e?.error ?? "",
    held: m.held,
    network: networkLine(m.network),
    networkDown: m.network.unreachable.length > 0,
    relayWarning: m.relayWarning,
    copyWarning: m.copyWarning,
    nextInLine: m.nextInLine,
  };
}

/** What a server's place in the line of succession says, in its tooltip; empty when it is not in the line. */
export function lineWords(n: number): string {
  if (n === 1)
    return "Next in line: if the leader's server stops, this server leads the cluster, with or without Deplo.";
  if (n === 2)
    return "Second in line: it leads the cluster if the leader's server and the one next in line both stop.";
  return "";
}

/** What a cluster knows about a server before it joins. */
export type ClusterJoinOption = {
  serverId: string;
  serverName: string;
  /** The first thing that stops it joining; empty when it can. */
  blocked: string;
  /** The Apps and databases on it now: they join the cluster with it. */
  apps: number;
  databases: number;
};

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "3 Apps and 1 database", or empty when the server runs nothing. */
export function comesAlong(apps: number, databases: number): string {
  return [
    apps > 0 && count(apps, "App"),
    databases > 0 && count(databases, "database"),
  ]
    .filter(Boolean)
    .join(" and ");
}

/** The Servers page, at the top level or inside one cluster. */
export function serversHref(
  opts: { cluster?: string | null; view?: ListView } = {},
): string {
  const params = new URLSearchParams();
  if (opts.cluster) params.set("cluster", opts.cluster);
  if (opts.view === "list") params.set("view", "list");
  const query = params.toString();
  return query ? `/settings/servers?${query}` : "/settings/servers";
}
