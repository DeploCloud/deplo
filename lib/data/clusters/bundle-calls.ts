import "server-only";

import { callClusterLeader } from "../../infra/agent-client/cluster-host";

// The failover-bundle block of the leader's call set (ADR-0045). JSON over the agent's forwarded call.
const enc = new TextEncoder();
const dec = new TextDecoder();

function json(raw: Uint8Array): Record<string, unknown> {
  try {
    const v = JSON.parse(dec.decode(raw)) as unknown;
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    // falls through
  }
  throw new Error("The cluster's leader gave an answer Deplo could not read.");
}

/** What the leader places the workload by when Deplo is away. No secret is in it. */
export interface BundleMeta {
  name: string;
  environment: string;
  image: string;
  archs: string[];
  limitMb: number;
  peakMb: number;
  hasDomain: boolean;
  createdAt: string;
}

export interface HeldBundle {
  kind: string;
  id: string;
  deploymentId: string;
}

/** `leader.key`: the leader's age public key. Only the public half ever leaves its machine. */
export async function askLeaderKey(serverId: string): Promise<string> {
  const a = json(await callClusterLeader(serverId, "leader.key"));
  if (typeof a.publicKey !== "string" || !a.publicKey.startsWith("age1"))
    throw new Error("The cluster's leader did not give a usable key.");
  return a.publicKey;
}

/** `leader.bundle.put`: stores one sealed bundle, replacing the workload's earlier one. */
export async function putLeaderBundle(
  serverId: string,
  b: {
    cluster: string;
    kind: string;
    id: string;
    deploymentId: string;
    sealed: Uint8Array;
    meta: BundleMeta;
  },
): Promise<void> {
  await callClusterLeader(
    serverId,
    "leader.bundle.put",
    enc.encode(
      JSON.stringify({
        cluster: b.cluster,
        kind: b.kind,
        id: b.id,
        deploymentId: b.deploymentId,
        sealed: Buffer.from(b.sealed).toString("base64"),
        meta: b.meta,
      }),
    ),
  );
}

/** `leader.bundle.drop`: forgets the workload's bundle. Nothing held is not an error. */
export async function dropLeaderBundle(
  serverId: string,
  b: { cluster: string; kind: string; id: string },
): Promise<void> {
  await callClusterLeader(
    serverId,
    "leader.bundle.drop",
    enc.encode(JSON.stringify(b)),
  );
}

/** `leader.bundle.list`: which bundle (by deployment id) the leader holds for each workload of the cluster. */
export async function listLeaderBundles(
  serverId: string,
  cluster: string,
): Promise<HeldBundle[]> {
  const a = json(
    await callClusterLeader(
      serverId,
      "leader.bundle.list",
      enc.encode(JSON.stringify({ cluster })),
    ),
  );
  if (!Array.isArray(a.bundles))
    throw new Error(
      "The cluster's leader gave an answer Deplo could not read.",
    );
  return a.bundles.map((b: Partial<HeldBundle>) => ({
    kind: String(b.kind ?? ""),
    id: String(b.id ?? ""),
    deploymentId: String(b.deploymentId ?? ""),
  }));
}

/** `leader.forget`: the leader drops the cluster, its bundles included. A cluster it never led is not an error. */
export async function forgetLeaderCluster(
  serverId: string,
  cluster: string,
): Promise<void> {
  await callClusterLeader(
    serverId,
    "leader.forget",
    enc.encode(JSON.stringify({ cluster })),
  );
}
