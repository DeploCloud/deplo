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
};

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
  };
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
