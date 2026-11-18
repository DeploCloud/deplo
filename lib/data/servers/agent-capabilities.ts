import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { clusterMembers } from "../../db/schema/control-plane/clusters";
import {
  serverAgentCapabilities,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { nowIso } from "../../ids";
import { isNewer } from "../../version";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";

// What a server's agent last said over Hello, so a render reads it instead of dialing (deplo#239's follow-up).
// A server that never reported lacks every capability; one that cannot answer keeps what it last said.

const SEEN_KEY = Symbol.for("deplo.agent-capabilities.seen");
const slot = globalThis as unknown as { [SEEN_KEY]?: Map<string, string> };
const seen = (slot[SEEN_KEY] ??= new Map());

const signature = (version: string, caps: string[]) =>
  `${version}|${[...caps].sort().join(",")}`;

/** Stores what a Hello reported, at once, and says in Activity when a capability went away. */
export async function recordAgentHello(
  serverId: string,
  agentVersion: string | undefined,
  capabilities: string[] | undefined,
): Promise<void> {
  if (!agentVersion) return;
  const caps = [...new Set(capabilities ?? [])].sort();
  const sig = signature(agentVersion, caps);
  if (seen.get(serverId) === sig) return;
  try {
    if (await instanceFrozen()) return;
    const db = getDb();
    const before = await db
      .select({
        capability: serverAgentCapabilities.capability,
        version: serverAgentCapabilities.agentVersion,
      })
      .from(serverAgentCapabilities)
      .where(eq(serverAgentCapabilities.serverId, serverId));
    const oldVersion = before[0]?.version;
    const dropped = before
      .map((r) => r.capability)
      .filter((c) => !caps.includes(c))
      .sort();
    if (
      before.length !== caps.length ||
      dropped.length > 0 ||
      oldVersion !== agentVersion
    ) {
      const at = nowIso();
      await db.transaction(async (tx) => {
        await tx
          .delete(serverAgentCapabilities)
          .where(eq(serverAgentCapabilities.serverId, serverId));
        if (caps.length > 0)
          await tx.insert(serverAgentCapabilities).values(
            caps.map((capability) => ({
              serverId,
              capability,
              agentVersion,
              reportedAt: at,
            })),
          );
      });
    }
    seen.set(serverId, sig);
    if (oldVersion && (dropped.length > 0 || isNewer(oldVersion, agentVersion)))
      await recordDowngrade(serverId, oldVersion, agentVersion, dropped);
  } catch (e) {
    seen.delete(serverId);
    console.error("[deplo] recording an agent's capabilities failed:", e);
  }
}

async function recordDowngrade(
  serverId: string,
  from: string,
  to: string,
  dropped: string[],
): Promise<void> {
  const [row] = await getDb()
    .select({ name: serversTable.name })
    .from(serversTable)
    .where(eq(serversTable.id, serverId));
  const name = row?.name ?? serverId;
  const what =
    dropped.length > 0 ? `: it no longer reports ${dropped.join(", ")}` : "";
  const moved = isNewer(from, to)
    ? `went back from v${from} to v${to}`
    : `changed from v${from} to v${to}`;
  await recordActivity(
    "server",
    `${name}'s server agent ${moved}${what}`,
    "Deplo",
  );
}

/** Whether every member of a cluster last reported the capability: one query, no dial. */
export async function clusterMembersReport(
  clusterId: string,
  capability: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({
      serverId: clusterMembers.serverId,
      capability: serverAgentCapabilities.capability,
    })
    .from(clusterMembers)
    .leftJoin(
      serverAgentCapabilities,
      and(
        eq(serverAgentCapabilities.serverId, clusterMembers.serverId),
        eq(serverAgentCapabilities.capability, capability),
      ),
    )
    .where(eq(clusterMembers.clusterId, clusterId));
  return rows.length > 0 && rows.every((r) => r.capability !== null);
}

/** The servers among `ids` whose agent last reported the capability. */
export async function serversReporting(
  ids: string[],
  capability: string,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .select({ serverId: serverAgentCapabilities.serverId })
    .from(serverAgentCapabilities)
    .where(
      and(
        inArray(serverAgentCapabilities.serverId, ids),
        eq(serverAgentCapabilities.capability, capability),
      ),
    );
  return new Set(rows.map((r) => r.serverId));
}

/** Test seam: forget which Hellos were already stored. */
export function __forgetAgentHellos(): void {
  seen.clear();
}
