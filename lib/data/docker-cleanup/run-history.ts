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
  /** Null once the server is removed - `serverName` is what keeps the row readable. */
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

/** Retention: how many runs PER SERVER the history keeps - the newest `3 ×
 *  serverCount` rows overall. */
const RUNS_KEPT_PER_SERVER = 3;
const MAX_RUN_LIMIT = 100;

/** The agent's cleanup deadline is 30min, plus slack for a dial on a host whose disk
 *  is full. Mirrors the backup runs' `RUN_ORPHAN_AFTER_MS`. */
const CLEANUP_ORPHAN_AFTER_MS = 90 * 60_000;

/** The servers with a sweep already in flight - session-free, for the scheduler tick. */
export async function listServersWithCleanupRunning(): Promise<string[]> {
  const rows = await getDb()
    .select({ serverId: dockerCleanupRuns.serverId })
    .from(dockerCleanupRuns)
    .where(eq(dockerCleanupRuns.status, "running"));
  return [
    ...new Set(rows.map((r) => r.serverId).filter((id): id is string => !!id)),
  ];
}

/** The history cap AND the read's default page: `3 × serverCount`, floored at
 *  {@link RUNS_KEPT_PER_SERVER} so a zero-server instance still shows the failure rows
 *  it may hold for servers that were since removed. */
async function runHistoryCap(): Promise<number> {
  const servers = await getDb()
    .select({ id: serversTable.id })
    .from(serversTable);
  return Math.max(RUNS_KEPT_PER_SERVER, servers.length * RUNS_KEPT_PER_SERVER);
}

/**
 * Cleanup history, newest first. NOT team-scoped - servers are the one shared
 * cross-team resource, so a run belongs to a host, not to a team; the gate is
 * instance-admin, checked here.
 */
export async function listCleanupRuns(
  filter: { serverId?: string; limit?: number } = {},
): Promise<CleanupRunDTO[]> {
  await requireInstanceAdmin();
  return loadRuns(filter);
}

/** The history, read WITHOUT a session - for the live subscription's generator. */
export async function listCleanupRunsForSubscriber(): Promise<CleanupRunDTO[]> {
  return loadRuns({});
}

/** The ungated body of {@link listCleanupRuns}. */
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

/**
 * Retention: trim the run history to {@link runHistoryCap}, deleting the older
 * TERMINAL rows (their per-scope items go with them via the FK CASCADE).
 */
export async function pruneCleanupRunHistory(): Promise<number> {
  const db = getDb();
  const keep = await runHistoryCap();
  const newest = await db
    .select({ id: dockerCleanupRuns.id })
    .from(dockerCleanupRuns)
    .orderBy(desc(dockerCleanupRuns.startedAt), desc(dockerCleanupRuns.seq))
    .limit(keep);
  // Fewer rows than the cap → nothing can be beyond it. Also guards the empty-table
  // case, where `notInArray` over an empty id list would be malformed SQL.
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

/**
 * Settle cleanup runs orphaned by a control-plane restart - the cleanup analogue
 * of `reconcileInFlightBackupRuns`. Session-free by construction: a boot hook has
 * no user to gate.
 */
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
