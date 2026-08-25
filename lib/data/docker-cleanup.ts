import "server-only";

import { and, desc, eq, inArray, lt, ne, notInArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appPreviews as appPreviewsTable,
  apps as appsTable,
  databases as databasesTable,
  dockerCleanupExcludedServers,
  dockerCleanupPolicy,
  dockerCleanupPolicyScopes,
  dockerCleanupRunItems,
  dockerCleanupRuns,
  servers as serversTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { publishCleanupRunsChanged } from "../graphql/pubsub";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import { recordActivity } from "./activity";
import { dispatchAlert, dispatchServerAlert } from "../notify/dispatch";
import { getServerById } from "./servers";
import { parseCron } from "../backups/cron";
import { runAgentCleanup } from "../infra/agent-client";
import { CleanupScope } from "../agent/gen/agent";
import type { CleanupScopeResult } from "../agent/gen/agent";
import { appBuildsItsOwnImage, formatBytes } from "../utils";
import { previewDeployKey } from "../deploy/deploy-key";
import { MAX_ROLLBACK_KEEP } from "../types";

/**
 * Docker cleanup - reclaiming disk on a server's host. There is exactly one
 * schedule to reason about, and a newly added server cannot silently go un-swept.
 * This module never touches a Docker socket (ADR-0006).
 */

/** The singleton policy row's PK - see the `docker_cleanup_policy` table comment. */
const POLICY_ID = "default";

/**
 * The four scopes that exist, in display order.
 */
export const CLEANUP_SCOPES = [
  "build_cache",
  "dangling_images",
  "orphan_buildkit_cache",
  "unused_app_images",
  "leftover_app_files",
] as const;

export type CleanupScopeId = (typeof CLEANUP_SCOPES)[number];
export type CleanupTrigger = "manual" | "scheduled";
export type CleanupRunStatus = "running" | "success" | "failed";

/** The instance-wide schedule + the hosts that sit it out. */
export interface CleanupPolicy {
  enabled: boolean;
  /** 5-field cron, evaluated in UTC. Validated on write - see {@link updateCleanupPolicy}. */
  schedule: string;
  minAgeHours: number;
  keepImagesPerApp: number;
  scopes: CleanupScopeId[];
  /** Servers the SCHEDULED sweep skips. A manual "clean up now" ignores this list. */
  excludedServerIds: string[];
  /** Null until the policy has been saved once (a missing row reads as the defaults). */
  updatedAt: string | null;
}

export interface UpdateCleanupPolicyInput {
  enabled: boolean;
  schedule: string;
  minAgeHours: number;
  keepImagesPerApp: number;
  scopes: CleanupScopeId[];
  /** Whole-set replace of the opt-out list; omit to leave it untouched. */
  excludedServerIds?: string[];
}

/** A run's per-scope breakdown. No `items`: the history keeps counts, not object ids. */
export interface CleanupRunItem {
  scope: CleanupScopeId;
  reclaimedBytes: number;
  itemsRemoved: number;
  skipped: boolean;
  error: string | null;
}

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

/* ------------------------------------------------------------------ */
/* Defaults + validation                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_SCHEDULE = "0 4 * * *";
/**
 * A day, and it gates only the CACHE scopes (build cache, dangling images, orphan
 * buildkit volumes).
 */
const DEFAULT_MIN_AGE_HOURS = 24;
const DEFAULT_KEEP_IMAGES_PER_APP = 1;

/**
 * The scopes a never-configured instance reclaims: ALL of them, and the schedule
 * ships ENABLED (see {@link loadPolicy}).
 */
const DEFAULT_SCOPES: CleanupScopeId[] = [...CLEANUP_SCOPES];

const MIN_AGE_HOURS_MAX = 8760; // a year
const KEEP_IMAGES_MAX = 20;

/**
 * Retention: how many runs PER SERVER the history keeps - the newest `3 ×
 * serverCount` rows overall.
 */
const RUNS_KEPT_PER_SERVER = 3;
const MAX_RUN_LIMIT = 100;

/**
 * The longest a real sweep could still be running before a `running` row is called
 * orphaned: the agent's cleanup deadline is 30min, plus slack for a dial on a host
 * whose disk is full. Mirrors the backup runs' `RUN_ORPHAN_AFTER_MS`.
 */
const CLEANUP_ORPHAN_AFTER_MS = 90 * 60_000;

function clampInt(
  n: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Canonicalize a scope list on WRITE: reject anything outside the allow-list, then
 * dedupe and order by {@link CLEANUP_SCOPES}. Deduping is not cosmetic -
 * `(policy_id, scope)` is the junction's PK, so a repeated scope would fail the save.
 */
function normalizeScopes(scopes: readonly string[]): CleanupScopeId[] {
  for (const s of scopes) {
    if (!(CLEANUP_SCOPES as readonly string[]).includes(s)) {
      throw new Error(`"${s}" is not a Docker cleanup scope`);
    }
  }
  return CLEANUP_SCOPES.filter((s) => scopes.includes(s));
}

/** The same canonicalization on READ, but TOLERANT: a stored scope this build does not
 *  know (a downgrade after a newer one wrote the policy) is dropped, not thrown on. A
 *  read that fails closed would take the whole settings page down over one stale row. */
function knownScopes(scopes: readonly string[]): CleanupScopeId[] {
  return CLEANUP_SCOPES.filter((s) => scopes.includes(s));
}

/** The message every "this host has no agent yet" path produces - one story, one string. */
function notProvisionedMessage(serverName: string): string {
  return `${serverName} is not provisioned yet - its agent has never called home. Finish provisioning the server, then clean up Docker.`;
}

/* ------------------------------------------------------------------ */
/* Wire mapping (control-plane scope id <-> proto enum)                */
/* ------------------------------------------------------------------ */

const SCOPE_TO_WIRE: Record<CleanupScopeId, CleanupScope> = {
  build_cache: CleanupScope.CLEANUP_SCOPE_BUILD_CACHE,
  dangling_images: CleanupScope.CLEANUP_SCOPE_DANGLING_IMAGES,
  orphan_buildkit_cache: CleanupScope.CLEANUP_SCOPE_ORPHAN_BUILDKIT_CACHE,
  unused_app_images: CleanupScope.CLEANUP_SCOPE_UNUSED_APP_IMAGES,
  leftover_app_files: CleanupScope.CLEANUP_SCOPE_LEFTOVER_APP_FILES,
};

const WIRE_TO_SCOPE = new Map<CleanupScope, CleanupScopeId>(
  (Object.entries(SCOPE_TO_WIRE) as [CleanupScopeId, CleanupScope][]).map(
    ([id, wire]) => [wire, id],
  ),
);

/**
 * Map the agent's per-scope results back to our ids, DEDUPED and with any scope we
 * do not recognise dropped (a newer agent could answer with an enum value this
 * control plane predates).
 */
function toRunItems(results: CleanupScopeResult[]): CleanupRunItem[] {
  const byScope = new Map<CleanupScopeId, CleanupRunItem>();
  for (const r of results) {
    const scope = WIRE_TO_SCOPE.get(r.scope);
    if (!scope) {
      console.warn(
        `[cleanup] agent reported an unknown scope (${r.scope}); ignoring it`,
      );
      continue;
    }
    if (byScope.has(scope)) continue;
    byScope.set(scope, {
      scope,
      reclaimedBytes: Number(r.reclaimedBytes ?? 0),
      itemsRemoved: r.itemsRemoved ?? 0,
      skipped: r.skipped ?? false,
      error: r.error || null,
    });
  }
  return CLEANUP_SCOPES.filter((s) => byScope.has(s)).map((s) =>
    byScope.get(s)!,
  );
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/**
 * Assemble the policy from its row + junctions.
 */
async function loadPolicy(): Promise<CleanupPolicy> {
  const db = getDb();
  const [rows, scopeRows, excludedRows] = await Promise.all([
    db
      .select()
      .from(dockerCleanupPolicy)
      .where(eq(dockerCleanupPolicy.id, POLICY_ID))
      .limit(1),
    db
      .select()
      .from(dockerCleanupPolicyScopes)
      .where(eq(dockerCleanupPolicyScopes.policyId, POLICY_ID)),
    // Read unconditionally: the exclusion list FKs to `servers`, not to the policy, so
    // it can legitimately outlive a policy that was never written.
    db.select().from(dockerCleanupExcludedServers),
  ]);
  const excludedServerIds = excludedRows.map((r) => r.serverId).sort();
  const row = rows[0];
  if (!row) {
    return {
      enabled: true,
      schedule: DEFAULT_SCHEDULE,
      minAgeHours: DEFAULT_MIN_AGE_HOURS,
      keepImagesPerApp: DEFAULT_KEEP_IMAGES_PER_APP,
      scopes: [...DEFAULT_SCOPES],
      excludedServerIds,
      updatedAt: null,
    };
  }
  return {
    enabled: row.enabled,
    schedule: row.schedule,
    minAgeHours: row.minAgeHours,
    keepImagesPerApp: row.keepImagesPerApp,
    scopes: knownScopes(scopeRows.map((r) => r.scope)),
    excludedServerIds,
    updatedAt: row.updatedAt,
  };
}

/** The instance-wide cleanup policy (the settings page's read). */
export async function getCleanupPolicy(): Promise<CleanupPolicy> {
  await requireInstanceAdmin();
  return loadPolicy();
}

/**
 * The policy, read WITHOUT a session - for the scheduler tick, which has no
 * request context to gate against (no cookies, no active team).
 */
export async function loadCleanupPolicyForScheduler(): Promise<CleanupPolicy> {
  return loadPolicy();
}

/**
 * The servers with a sweep already in flight - session-free, for the same reason
 * as {@link loadCleanupPolicyForScheduler}.
 */
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

/**
 * The history, read WITHOUT a session - for the live subscription's generator,
 * which re-reads it on every published change.
 */
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

/** Per-scope lines always read in the allow-list's order, whatever order they landed in. */
function orderItems(items: CleanupRunItem[]): CleanupRunItem[] {
  return CLEANUP_SCOPES.flatMap((s) => items.filter((i) => i.scope === s));
}

/**
 * Retention: trim the run history to {@link runHistoryCap} - the newest `3 ×
 * serverCount` rows - deleting the older TERMINAL rows (their per-scope items go
 * with them via the FK CASCADE).
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

/* ------------------------------------------------------------------ */
/* Config mutation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Save the instance-wide policy: the singleton row + a whole-set replace of its
 * scopes (and of the exclusion list, when one is sent) in ONE transaction, so a
 * save is never half-applied - a policy that kept a scope the operator just
 */
export async function updateCleanupPolicy(
  input: UpdateCleanupPolicyInput,
): Promise<CleanupPolicy> {
  await requireInstanceAdmin();
  // Only to attribute the activity row - the policy itself is instance-wide.
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const schedule = input.schedule.trim();
  if (!parseCron(schedule)) {
    throw new Error(
      `"${schedule}" is not a valid cron expression. Use 5 fields, minute hour day month weekday, e.g. "0 4 * * *" for daily at 04:00 UTC.`,
    );
  }
  const scopes = normalizeScopes(input.scopes);
  // An enabled policy with nothing to reclaim is the same silent lie as an unparseable
  // cron: a job that runs nightly and does nothing, reported as working.
  if (input.enabled && scopes.length === 0) {
    throw new Error(
      "Select at least one thing to reclaim before enabling the scheduled cleanup",
    );
  }
  const minAgeHours = clampInt(
    input.minAgeHours,
    0,
    MIN_AGE_HOURS_MAX,
    DEFAULT_MIN_AGE_HOURS,
  );
  const keepImagesPerApp = clampInt(
    input.keepImagesPerApp,
    1,
    KEEP_IMAGES_MAX,
    DEFAULT_KEEP_IMAGES_PER_APP,
  );
  const excluded = input.excludedServerIds
    ? [...new Set(input.excludedServerIds)]
    : undefined;

  const now = nowIso();
  await getDb().transaction(async (tx) => {
    await tx
      .insert(dockerCleanupPolicy)
      .values({
        id: POLICY_ID,
        enabled: input.enabled,
        schedule,
        minAgeHours,
        keepImagesPerApp,
        createdAt: now,
        updatedAt: now,
      })
      // The PK is a literal, so this upsert IS the whole write path: two concurrent
      // saves settle on one row rather than minting two policies.
      .onConflictDoUpdate({
        target: dockerCleanupPolicy.id,
        set: {
          enabled: input.enabled,
          schedule,
          minAgeHours,
          keepImagesPerApp,
          updatedAt: now,
        },
      });

    await tx
      .delete(dockerCleanupPolicyScopes)
      .where(eq(dockerCleanupPolicyScopes.policyId, POLICY_ID));
    if (scopes.length > 0) {
      await tx
        .insert(dockerCleanupPolicyScopes)
        .values(scopes.map((scope) => ({ policyId: POLICY_ID, scope })));
    }

    if (excluded) {
      // Drop ids that are not (or are no longer) servers rather than letting the FK
      // reject the save with an opaque constraint error: membership in this list is
      // the whole record, so a stale id carries no meaning worth failing a save over.
      const known =
        excluded.length > 0
          ? (
              await tx
                .select({ id: serversTable.id })
                .from(serversTable)
                .where(inArray(serversTable.id, excluded))
            ).map((r) => r.id)
          : [];
      await tx.delete(dockerCleanupExcludedServers);
      if (known.length > 0) {
        await tx
          .insert(dockerCleanupExcludedServers)
          .values(known.map((serverId) => ({ serverId })));
      }
    }
  });

  await recordActivity(
    "cleanup",
    input.enabled
      ? `Updated the Docker cleanup policy (${schedule} UTC)`
      : "Disabled the scheduled Docker cleanup",
    user.name,
    null,
    teamId,
  );
  return loadPolicy();
}

/**
 * Include ONE server in the scheduled sweep, or leave it out.
 */
export async function setServerCleanupExcluded(
  serverId: string,
  excluded: boolean,
): Promise<CleanupPolicy> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(serverId);
  if (!server) throw new Error("Server not found");

  if (excluded) {
    await getDb()
      .insert(dockerCleanupExcludedServers)
      .values({ serverId })
      .onConflictDoNothing();
  } else {
    await getDb()
      .delete(dockerCleanupExcludedServers)
      .where(eq(dockerCleanupExcludedServers.serverId, serverId));
  }

  await recordActivity(
    "cleanup",
    excluded
      ? `Excluded ${server.name} from the scheduled Docker cleanup`
      : `Included ${server.name} in the scheduled Docker cleanup`,
    user.name,
    null,
    teamId,
  );
  return loadPolicy();
}

/* ------------------------------------------------------------------ */
/* The executor                                                        */
/* ------------------------------------------------------------------ */

/**
 * The executor's FIRST half: put the sweep on the record as `running`, before a
 * single byte is asked of the host.
 */
async function beginCleanupRun(args: {
  serverId: string;
  serverName: string;
  actor: string;
  trigger: CleanupTrigger;
}): Promise<CleanupRunDTO> {
  const { serverId, serverName, actor, trigger } = args;
  const startedAt = nowIso();
  const runId = newId("dcr");

  // Short transaction, nothing else inside it: the agent is dialled later, outside.
  await getDb().transaction(async (tx) => {
    await tx.insert(dockerCleanupRuns).values({
      id: runId,
      serverId,
      serverName,
      trigger,
      actor,
      status: "running",
      error: null,
      reclaimedBytes: 0,
      startedAt,
      finishedAt: null,
    });
  });
  // Every watching settings page shows the new row immediately, including the one
  // belonging to the admin who clicked, whose own mutation result says the same thing.
  publishCleanupRunsChanged();

  return {
    id: runId,
    serverId,
    serverName,
    trigger,
    actor,
    status: "running",
    error: null,
    reclaimedBytes: 0,
    startedAt,
    finishedAt: null,
    items: [],
  };
}

/**
 * The executor's SECOND half - the slow one: dial the host, then settle the run
 * row that {@link beginCleanupRun} already wrote. NEVER throws.
 */
async function finishCleanupRun(args: {
  runId: string;
  serverId: string;
  serverName: string;
  actor: string;
  policy: CleanupPolicy;
  /** The team the activity row is attributed to; null for a tick, which has no active team. */
  teamId: string | null;
}): Promise<CleanupRunDTO> {
  const { runId, serverId, serverName, actor, policy, teamId } = args;

  let failure: string | null = null;
  let reclaimedBytes = 0;
  let items: CleanupRunItem[] = [];
  try {
    // The provisioning check lives HERE, after the run row exists, so a host whose
    // agent never called home leaves the same failed run as one that went offline,
    // and an actionable message, rather than the dial's "not provisioned" internals.
    const server = await getServerById(serverId);
    if (!server) throw new Error("Server not found");
    if (!server.agent?.certFingerprint)
      throw new Error(notProvisionedMessage(serverName));

    const resp = await runAgentCleanup(serverId, {
      scopes: policy.scopes.map((s) => SCOPE_TO_WIRE[s]),
      dryRun: false,
      minAgeHours: policy.minAgeHours,
      keepImagesPerApp: policy.keepImagesPerApp,
      // Per-app retention wins over the instance number wherever an app names one
      // - that is what keeps its rollbacks alive. See rollbackKeepBySlug.
      keepPerSlug: await rollbackKeepBySlug(serverId),
      // What `leftover_app_files` judges a directory against.
      liveSlugs: policy.scopes.includes("leftover_app_files")
        ? await liveStackSlugs()
        : [],
    });
    // A per-scope `error`/`skipped` is NOT a run failure - the agent declines a scope it
    // cannot prove is safe and sweeps the rest. Only `ok:false` (the sweep could not
    // start at all) fails the run, and its partial results are still worth recording.
    items = toRunItems(resp.results ?? []);
    reclaimedBytes = Number(resp.reclaimedBytes ?? 0);
    if (!resp.ok) failure = resp.error || "the agent reported a failed cleanup";
  } catch (e) {
    // Every failure funnels here: unknown/unprovisioned server, AgentUnreachableError,
    // AgentCleanupUnsupportedError ("update the agent on this server"), a docker error
    // the agent reported.
    failure = e instanceof Error ? e.message : String(e);
  }

  const finishedAt = nowIso();
  // TERMINAL transaction (short): the run's final status + its per-scope breakdown,
  // together - a run that reports bytes with no lines, or lines with no status, is a
  // half-truth. Rule (b): the agent call is already done, outside any tx.
  const finished = await getDb().transaction(
    async (tx): Promise<CleanupRunDTO> => {
      const updated = await tx
        .update(dockerCleanupRuns)
        .set({
          status: failure ? "failed" : "success",
          error: failure,
          reclaimedBytes,
          finishedAt,
        })
        .where(eq(dockerCleanupRuns.id, runId))
        .returning();
      if (items.length > 0) {
        await tx.insert(dockerCleanupRunItems).values(
          items.map((i) => ({
            runId,
            scope: i.scope,
            reclaimedBytes: i.reclaimedBytes,
            itemsRemoved: i.itemsRemoved,
            skipped: i.skipped,
            error: i.error,
          })),
        );
      }
      const row = updated[0]!;
      return {
        id: row.id,
        serverId: row.serverId,
        serverName: row.serverName,
        trigger: row.trigger as CleanupTrigger,
        actor: row.actor,
        status: row.status as CleanupRunStatus,
        error: row.error,
        reclaimedBytes: row.reclaimedBytes,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        items: orderItems(items),
      };
    },
  );

  // Retention rides the executor: every finished sweep, success or failure, trims
  // the history to its cap. Best-effort: a failed trim must never turn a recorded
  // sweep into a thrown one, so it only warns.
  try {
    await pruneCleanupRunHistory();
  } catch (e) {
    console.warn(
      `[cleanup] could not prune the run history: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Rule (c): outside every transaction, fire-and-forget. A scheduled run passes
  // teamId `null` (a tick has no active team) and recordActivity attributes it to the
  // first team - the same compromise the nightly backup makes.
  await recordActivity(
    "cleanup",
    failure
      ? `Docker cleanup on ${serverName} failed: ${failure}`
      : `Docker cleanup on ${serverName} reclaimed ${formatBytes(reclaimedBytes)}`,
    actor,
    null,
    teamId,
  );
  // Only the failure is worth pushing: a sweep that reclaimed disk is good news
  // nobody needs woken for, and it is already in the trail above. A tick has no
  // team, so it fans out to whoever runs something on the host.
  if (failure) {
    const alert = {
      key: "cleanup_failed" as const,
      title: `Cleanup failed on ${serverName}`,
      body: failure,
      path: "/settings/servers",
      dedupe: { id: `cleanup:${serverId}`, state: "failed" },
    };
    if (teamId) dispatchAlert({ ...alert, teamId });
    else dispatchServerAlert(serverId, alert);
  }

  // LAST, after the row, its items and the retention pass are all settled: whoever is
  // watching re-reads a consistent history, and the row they were watching spin is
  // the one that just changed.
  publishCleanupRunsChanged();
  return finished;
}

/* ------------------------------------------------------------------ */
/* Detached sweeps                                                     */
/* ------------------------------------------------------------------ */

/**
 * The manual sweeps still working their host, runId → the promise that settles
 * them.
 */
const detachedSweeps = new Map<string, Promise<void>>();

/**
 * Run the slow half detached: nobody awaits it, so the HTTP request that started
 * the sweep has already answered.
 */
function detachSweep(runId: string, work: Promise<CleanupRunDTO>): void {
  const tracked = work
    .then((run) => {
      if (run.status === "failed") {
        console.warn(
          `[cleanup] sweep on ${run.serverName} failed: ${run.error}`,
        );
      }
    })
    .catch((e) => {
      // finishCleanupRun does not throw; reaching here means the STORE failed (the
      // terminal transaction itself), which leaves the row `running` for the boot
      // reconcile to settle. Nothing better to do than say so loudly.
      console.error(
        `[cleanup] could not settle run ${runId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    })
    .finally(() => {
      detachedSweeps.delete(runId);
    });
  detachedSweeps.set(runId, tracked);
}

/**
 * Test-only: wait for every detached sweep this process started. Production code
 * must never call it - the whole point of a detached sweep is that no request
 * waits on one.
 */
export async function __settleCleanupSweeps(): Promise<void> {
  while (detachedSweeps.size > 0) {
    await Promise.all([...detachedSweeps.values()]);
  }
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

/**
 * START a sweep of one server NOW, with the instance policy's scopes.
 */
export async function runCleanupNow(serverId: string): Promise<CleanupRunDTO> {
  await requireInstanceAdmin();
  // Only to attribute the activity row - the sweep belongs to a host, not a team.
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  // UNSCOPED resolve, and correct now that the gate is instance-admin: this page
  // lists every host (a server reserved for another team fills the same disk), and an
  // instance admin already administers all of them.
  const server = await getServerById(serverId);
  if (!server) throw new Error("Server not found");
  // Same refusal the scheduler makes, and it has to be here too: this is the MANUAL
  // sweep, reachable from the API and from MCP, and reclaiming disk on a migration
  // source would delete the other platform's images while it is running on them.
  if (server.importOnly)
    throw new Error(
      `${server.name} is a migration source - Deplo does not reclaim disk on a ` +
        `machine it is only importing from.`,
    );

  const policy = await loadPolicy();
  // Fail fast rather than record a run that asks the agent for nothing: an empty scope
  // set is an ok response with zero bytes, indistinguishable from a sweep that worked.
  if (policy.scopes.length === 0) {
    throw new Error(
      "No cleanup scopes are selected - choose what to reclaim, then clean up",
    );
  }
  // The same never-stack-sweeps rule the scheduler follows, and it matters more now
  // that the button answers instantly: two concurrent `docker rmi` sweeps would race
  // each other's candidate lists, and a second click is far likelier when the first
  if ((await listServersWithCleanupRunning()).includes(serverId)) {
    throw new Error(`A cleanup is already running on ${server.name}`);
  }

  const run = await beginCleanupRun({
    serverId,
    serverName: server.name,
    actor: user.name,
    trigger: "manual",
  });
  detachSweep(
    run.id,
    finishCleanupRun({
      runId: run.id,
      serverId,
      serverName: server.name,
      actor: user.name,
      policy,
      teamId,
    }),
  );
  return run;
}

/**
 * The session-free twin of {@link runCleanupNow}, for the scheduler tick. NEVER
 * throws - the failure is already on the run row, and one unreachable host must
 * not abort the rest of the tick.
 */
export async function runScheduledCleanup(
  serverId: string,
  serverName: string,
  policy: CleanupPolicy,
): Promise<void> {
  try {
    const run = await beginCleanupRun({
      serverId,
      serverName,
      actor: "Scheduler",
      trigger: "scheduled",
    });
    await finishCleanupRun({
      runId: run.id,
      serverId,
      serverName,
      actor: "Scheduler",
      policy,
      teamId: null,
    });
  } catch (e) {
    // Only a STORE failure reaches here (finishCleanupRun swallows the host's). The
    // tick has nobody to tell, so log and let the next host run.
    console.warn(
      `[cleanup] scheduled sweep on ${serverName} could not be recorded: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Servers with a deploy-triggered sweep in flight - a second one would only race the
 *  first's candidate list; the next deploy catches anything it missed. */
const deploySweepInFlight = new Set<string>();

/**
 * Snapshot of {@link deploySweepInFlight}, for the scheduler's never-stack-sweeps
 * check: the deploy-time sweep writes NO run row on purpose, so without this
 * in-process signal a tick could start a scheduled sweep on a host whose images a
 */
export function serversWithDeploySweepInFlight(): string[] {
  return [...deploySweepInFlight];
}

/**
 * How many app images each app on `serverId` must keep - its rollback depth plus
 * the one that is live. An app at 0 lands on 1, which is also the floor the agent
 * enforces anyway (a stopped app must stay startable without a rebuild).
 */
export async function rollbackKeepBySlug(
  serverId: string,
): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({
      slug: appsTable.slug,
      keep: appsTable.rollbackKeep,
      source: appsTable.source,
      compose: appsTable.compose,
      repoUrl: appsTable.repoUrl,
      dockerImage: appsTable.dockerImage,
    })
    .from(appsTable)
    .where(eq(appsTable.serverId, serverId));
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!appBuildsItsOwnImage({ ...r, repo: r.repoUrl })) continue;
    // Clamped at BOTH ends, not just the floor.
    out[r.slug] = Math.min(
      MAX_ROLLBACK_KEEP + 1,
      Math.max(1, Math.trunc(r.keep) + 1),
    );
  }
  return out;
}

/**
 * Every stack slug this Deplo still knows about - the proof `leftover_app_files`
 * rests on, and the one list that decides whether a directory on a host is
 * somebody's configuration or litter.
 */
export async function liveStackSlugs(): Promise<string[]> {
  const db = getDb();
  const [apps, previews, databases] = await Promise.all([
    db.select({ slug: appsTable.slug }).from(appsTable),
    db
      .select({ slug: appsTable.slug, prNumber: appPreviewsTable.prNumber })
      .from(appPreviewsTable)
      .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId)),
    db.select({ host: databasesTable.host }).from(databasesTable),
  ]);
  const slugs = new Set<string>();
  for (const a of apps) slugs.add(a.slug);
  for (const p of previews) slugs.add(previewDeployKey(p.slug, p.prNumber));
  for (const d of databases) slugs.add(d.host);
  return [...slugs];
}

/**
 * Remove the superseded app images a deploy just left behind on `serverId` - the
 * deploy-time half of app-image retention. Scope is `unused_app_images` ONLY - the
 * cache scopes stay on the schedule where their age filter belongs.
 */
export async function sweepSupersededAppImages(
  serverId: string,
): Promise<number> {
  if (deploySweepInFlight.has(serverId)) return 0;
  deploySweepInFlight.add(serverId);
  try {
    const policy = await loadPolicy();
    if (!policy.scopes.includes("unused_app_images")) return 0;
    if (policy.excludedServerIds.includes(serverId)) return 0;
    // A full sweep already running on this host will get there itself.
    if ((await listServersWithCleanupRunning()).includes(serverId)) return 0;

    const resp = await runAgentCleanup(serverId, {
      scopes: [SCOPE_TO_WIRE.unused_app_images],
      dryRun: false,
      // Carried for wire compatibility; agents ≥ 1.12 ignore it for this scope
      // (count-based retention + their fixed deploy grace decide).
      minAgeHours: policy.minAgeHours,
      keepImagesPerApp: policy.keepImagesPerApp,
      // THE sweep that decides whether a rollback is possible: this one runs right after
      // the deploy that superseded the previous image, so if it reads the instance scalar
      // instead of the app's own depth, the rollback target is gone before anybody could
      keepPerSlug: await rollbackKeepBySlug(serverId),
      // Images only here: the files sweep belongs on the schedule, where an app
      // deleted an hour ago is already past its grace window.
      liveSlugs: [],
    });
    if (!resp.ok) {
      console.warn(
        `[cleanup] deploy-time image sweep on ${serverId} failed: ${resp.error || "unknown"}`,
      );
      return 0;
    }
    return Number(resp.reclaimedBytes ?? 0);
  } catch (e) {
    console.warn(
      `[cleanup] deploy-time image sweep on ${serverId} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 0;
  } finally {
    deploySweepInFlight.delete(serverId);
  }
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
