import "server-only";

import { and, desc, eq, inArray, lt, ne, notInArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  dockerCleanupRunItems,
  dockerCleanupRuns,
} from "../../db/schema/control-plane/docker-cleanup";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { publishCleanupRunsChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import { clampInt } from "./policy";
import {
  orderItems,
  type CleanupRunItem,
  type CleanupRunStatus,
  type CleanupScopeId,
  type CleanupTrigger,
} from "./scopes";

export interface CleanupRunDTO {
  id: string;
  serverId: string | null;
  serverName: string;
  trigger: CleanupTrigger;
  actor: string;
  status: CleanupRunStatus;
  error: string | null;
  reclaimedBytes: number;
  startedAt: string;
  finishedAt: string | null;
  items: CleanupRunItem[];
}

const RUNS_KEPT_PER_SERVER = 3;
const MAX_RUN_LIMIT = 100;

const CLEANUP_ORPHAN_AFTER_MS = 90 * 60_000;

export async function listServersWithCleanupRunning(): Promise<string[]> {
  const rows = await getDb()
    .select({ serverId: dockerCleanupRuns.serverId })
    .from(dockerCleanupRuns)
    .where(eq(dockerCleanupRuns.status, "running"));
  return [
    ...new Set(rows.map((r) => r.serverId).filter((id): id is string => !!id)),
  ];
}

async function runHistoryCap(): Promise<number> {
  const servers = await getDb()
    .select({ id: serversTable.id })
    .from(serversTable);
  return Math.max(RUNS_KEPT_PER_SERVER, servers.length * RUNS_KEPT_PER_SERVER);
}

export async function listCleanupRuns(
  filter: { serverId?: string; limit?: number } = {},
): Promise<CleanupRunDTO[]> {
  await requireInstanceAdmin();
  return loadRuns(filter);
}

export async function listCleanupRunsForSubscriber(): Promise<CleanupRunDTO[]> {
  return loadRuns({});
}

async function loadRuns(
  filter: { serverId?: string; limit?: number } = {},
): Promise<CleanupRunDTO[]> {
  const fallback = filter.limit ?? (await runHistoryCap());
  const limit = clampInt(fallback, 1, MAX_RUN_LIMIT, RUNS_KEPT_PER_SERVER);
  const rows = await getDb()
    .select()
    .from(dockerCleanupRuns)
    .where(
      filter.serverId
        ? eq(dockerCleanupRuns.serverId, filter.serverId)
        : undefined,
    )
    .orderBy(desc(dockerCleanupRuns.startedAt), desc(dockerCleanupRuns.seq))
    .limit(limit);
  if (rows.length === 0) return [];

  const itemRows = await getDb()
    .select()
    .from(dockerCleanupRunItems)
    .where(
      inArray(
        dockerCleanupRunItems.runId,
        rows.map((r) => r.id),
      ),
    );
  const byRun = new Map<string, CleanupRunItem[]>();
  for (const i of itemRows) {
    const list = byRun.get(i.runId) ?? [];
    list.push({
      scope: i.scope as CleanupScopeId,
      reclaimedBytes: i.reclaimedBytes,
      itemsRemoved: i.itemsRemoved,
      skipped: i.skipped,
      error: i.error,
    });
    byRun.set(i.runId, list);
  }
  return rows.map((r) => ({
    id: r.id,
    serverId: r.serverId,
    serverName: r.serverName,
    trigger: r.trigger as CleanupTrigger,
    actor: r.actor,
    status: r.status as CleanupRunStatus,
    error: r.error,
    reclaimedBytes: r.reclaimedBytes,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    items: orderItems(byRun.get(r.id) ?? []),
  }));
}

export async function pruneCleanupRunHistory(): Promise<number> {
  const db = getDb();
  const keep = await runHistoryCap();
  const newest = await db
    .select({ id: dockerCleanupRuns.id })
    .from(dockerCleanupRuns)
    .orderBy(desc(dockerCleanupRuns.startedAt), desc(dockerCleanupRuns.seq))
    .limit(keep);
  if (newest.length < keep) return 0;
  const removed = await db
    .delete(dockerCleanupRuns)
    .where(
      and(
        ne(dockerCleanupRuns.status, "running"),
        notInArray(
          dockerCleanupRuns.id,
          newest.map((r) => r.id),
        ),
      ),
    )
    .returning({ id: dockerCleanupRuns.id });
  return removed.length;
}

export async function reconcileInFlightCleanupRuns(): Promise<number> {
  const cutoffIso = new Date(
    Date.now() - CLEANUP_ORPHAN_AFTER_MS,
  ).toISOString();
  const flipped = await getDb()
    .update(dockerCleanupRuns)
    .set({
      status: "failed",
      error: "Interrupted by a control-plane restart and marked failed.",
      finishedAt: nowIso(),
    })
    .where(
      and(
        eq(dockerCleanupRuns.status, "running"),
        lt(dockerCleanupRuns.startedAt, cutoffIso),
      ),
    )
    .returning({ id: dockerCleanupRuns.id });

  if (flipped.length > 0) {
    console.warn(
      `[deplo] reconciled ${flipped.length} interrupted Docker cleanup run(s) to failed on startup`,
    );
    publishCleanupRunsChanged();
  }
  return flipped.length;
}
