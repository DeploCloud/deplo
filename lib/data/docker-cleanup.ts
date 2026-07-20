import "server-only";

import { and, desc, eq, inArray, lt, ne, notInArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  dockerCleanupExcludedServers,
  dockerCleanupPolicy,
  dockerCleanupPolicyScopes,
  dockerCleanupRunItems,
  dockerCleanupRuns,
  servers as serversTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { getServer, getServerById } from "./servers";
import { parseCron } from "../backups/cron";
import { runAgentCleanup } from "../infra/agent-client";
import { CleanupScope } from "../agent/gen/agent";
import type { CleanupScopeResult } from "../agent/gen/agent";
import { formatBytes } from "../utils";

/**
 * Docker cleanup — reclaiming disk on a server's host.
 *
 * The shape here follows two decisions that are easy to mistake for accidents:
 *
 *  - The SCHEDULE is instance-wide (one {@link dockerCleanupPolicy} singleton) and a
 *    host opts OUT via {@link dockerCleanupExcludedServers}. There is exactly one
 *    schedule to reason about, and a newly added server cannot silently go un-swept.
 *  - The gate is `manage_infra`, not instance-admin: reclaiming build cache is
 *    operational hygiene, and the operators who run out of disk are the ones who
 *    already hold `manage_infra`. Servers are cross-team infra, so the policy and
 *    the run history are NOT team-scoped — the `teamId` we resolve is used only to
 *    attribute the activity row. The interactive per-server entry points
 *    (preview / "clean up now") DO resolve their target team-scoped, though: a
 *    host reserved for another team is not this caller's to prune.
 *
 * WHAT gets deleted is not decided here. The control plane owns the scope SET; the
 * agent owns the deletion, allow-listed (never `system`/`container`/`volume`/`network
 * prune`), because on a Deplo host a STOPPED app is a live app and a dangling volume
 * may hold user data. This module never touches a Docker socket (ADR-0006).
 */

/** The singleton policy row's PK — see the `docker_cleanup_policy` table comment. */
const POLICY_ID = "default";

/**
 * The four scopes that exist, in display order. An ALLOW-LIST and CLOSED: it mirrors
 * the agent's `CleanupScope` proto enum one-for-one, and container/volume/network/
 * `system` prune are deliberately absent. Adding an entry here without the agent
 * knowing it means the agent refuses the scope — it decides, not us.
 */
export const CLEANUP_SCOPES = [
  "build_cache",
  "dangling_images",
  "orphan_buildkit_cache",
  "unused_app_images",
] as const;

export type CleanupScopeId = (typeof CLEANUP_SCOPES)[number];
export type CleanupTrigger = "manual" | "scheduled";
export type CleanupRunStatus = "running" | "success" | "failed";

/** The instance-wide schedule + the hosts that sit it out. */
export interface CleanupPolicy {
  enabled: boolean;
  /** 5-field cron, evaluated in UTC. Validated on write — see {@link updateCleanupPolicy}. */
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

/** One scope's line in a preview — what the agent WOULD reclaim, having removed nothing. */
export interface CleanupReportScope {
  scope: CleanupScopeId;
  reclaimedBytes: number;
  itemsRemoved: number;
  /** The image ids / volume names in question (agent-bounded to 200; `itemsRemoved` is authoritative). */
  items: string[];
  skipped: boolean;
  error: string | null;
}

export interface CleanupReport {
  serverId: string;
  serverName: string;
  reclaimedBytes: number;
  scopes: CleanupReportScope[];
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
  /** Null once the server is removed — `serverName` is what keeps the row readable. */
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
 * A day — and it gates only the CACHE scopes (build cache, dangling images, orphan
 * buildkit volumes). App images are count-based (`keepImagesPerApp` + the agent's
 * fixed 1h deploy grace) and ignore this on agents ≥ 1.12.
 *
 * It was a week (168h), and that default was the root cause of a recurring disk
 * saturation: a host that redeploys many times a day fills in hours, so nothing
 * ever aged into eligibility and every sweep "succeeded" with 0 bytes. Anything a
 * live build still wants is hours old at most; a week protects nothing real.
 * Migration 0040 moves stored policies still on the old default to this one.
 */
const DEFAULT_MIN_AGE_HOURS = 24;
const DEFAULT_KEEP_IMAGES_PER_APP = 1;

/**
 * The scopes a never-configured instance reclaims: ALL of them, and the schedule ships
 * ENABLED (see {@link loadPolicy}). Both flipped by an explicit owner decision
 * (2026-07): disk hygiene is the platform's job — a full disk blocks every build, and
 * "the operator must remember to turn the janitor on" is exactly the kind of manual
 * step the north star forbids. `unused_app_images` is included because its guardrails
 * make the worst case a rebuild of an OLD version, never a stranded app:
 * `keepImagesPerApp` always keeps the newest image(s), and an image any container —
 * running or stopped — references is never a candidate. An operator who wants the
 * conservative set unchecks it once; the saved row wins from then on.
 */
const DEFAULT_SCOPES: CleanupScopeId[] = [...CLEANUP_SCOPES];

const MIN_AGE_HOURS_MAX = 8760; // a year
const KEEP_IMAGES_MAX = 20;

/**
 * Retention: how many runs PER SERVER the history keeps — the newest
 * `3 × serverCount` rows overall. At the default daily cadence that is about three
 * days of logs, which is all the history is for ("did last night's sweep work, and
 * the two before it?"); it is also the default page {@link listCleanupRuns} shows,
 * so what the UI lists and what the store keeps are the same number by construction.
 */
const RUNS_KEPT_PER_SERVER = 3;
const MAX_RUN_LIMIT = 100;

/**
 * The longest a real sweep could still be running before a `running` row is called
 * orphaned: the agent's cleanup deadline is 30min, plus slack for a dial on a host
 * whose disk is full. Mirrors the backup runs' `RUN_ORPHAN_AFTER_MS`.
 */
const CLEANUP_ORPHAN_AFTER_MS = 90 * 60_000;

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Canonicalize a scope list on WRITE: reject anything outside the allow-list, then
 * dedupe and order by {@link CLEANUP_SCOPES}. Deduping is not cosmetic —
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

/** The message every "this host has no agent yet" path produces — one story, one string. */
function notProvisionedMessage(serverName: string): string {
  return `${serverName} is not provisioned yet — its agent has never called home. Finish provisioning the server, then clean up Docker.`;
}

/* ------------------------------------------------------------------ */
/* Wire mapping (control-plane scope id <-> proto enum)                */
/* ------------------------------------------------------------------ */

const SCOPE_TO_WIRE: Record<CleanupScopeId, CleanupScope> = {
  build_cache: CleanupScope.CLEANUP_SCOPE_BUILD_CACHE,
  dangling_images: CleanupScope.CLEANUP_SCOPE_DANGLING_IMAGES,
  orphan_buildkit_cache: CleanupScope.CLEANUP_SCOPE_ORPHAN_BUILDKIT_CACHE,
  unused_app_images: CleanupScope.CLEANUP_SCOPE_UNUSED_APP_IMAGES,
};

const WIRE_TO_SCOPE = new Map<CleanupScope, CleanupScopeId>(
  (Object.entries(SCOPE_TO_WIRE) as [CleanupScopeId, CleanupScope][]).map(
    ([id, wire]) => [wire, id],
  ),
);

/**
 * Map the agent's per-scope results back to our ids, DEDUPED and with any scope we do
 * not recognise dropped (a newer agent could answer with an enum value this control
 * plane predates). Both guards protect the SAME thing: `(run_id, scope)` is the run
 * items' PK, and a duplicate or an unmappable scope would roll back the terminal
 * transaction — leaving the run stuck `running` forever, which is a worse lie than a
 * missing line in the breakdown.
 */
function toRunItems(results: CleanupScopeResult[]): CleanupRunItem[] {
  const byScope = new Map<CleanupScopeId, CleanupRunItem>();
  for (const r of results) {
    const scope = WIRE_TO_SCOPE.get(r.scope);
    if (!scope) {
      console.warn(`[cleanup] agent reported an unknown scope (${r.scope}); ignoring it`);
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
  return CLEANUP_SCOPES.filter((s) => byScope.has(s)).map((s) => byScope.get(s)!);
}

function toReportScopes(results: CleanupScopeResult[]): CleanupReportScope[] {
  const items = toRunItems(results);
  const itemNames = new Map<CleanupScopeId, string[]>();
  for (const r of results) {
    const scope = WIRE_TO_SCOPE.get(r.scope);
    if (scope && !itemNames.has(scope)) itemNames.set(scope, r.items ?? []);
  }
  return items.map((i) => ({ ...i, items: itemNames.get(i.scope) ?? [] }));
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Assemble the policy from its row + junctions. A MISSING row is legal: the instance
 *  has never configured cleanup, and reads as the DEFAULTS — which since 2026-07 are
 *  "enabled, daily at 04:00 UTC, every scope": a fresh install sweeps its hosts without
 *  anyone finding the settings page first. The scheduler reads through this same path,
 *  so the default is live behavior, not just what the form shows. An instance that
 *  SAVED a policy (row present) always reads its own row — an operator's explicit
 *  disable survives every upgrade. */
async function loadPolicy(): Promise<CleanupPolicy> {
  const db = getDb();
  const [rows, scopeRows, excludedRows] = await Promise.all([
    db.select().from(dockerCleanupPolicy).where(eq(dockerCleanupPolicy.id, POLICY_ID)).limit(1),
    db.select().from(dockerCleanupPolicyScopes).where(eq(dockerCleanupPolicyScopes.policyId, POLICY_ID)),
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
  await requireCapability("manage_infra");
  return loadPolicy();
}

/**
 * The policy, read WITHOUT a session — for the scheduler tick, which has no request
 * context to gate against (no cookies, no active team). This is not a hole in the
 * `manage_infra` gate: the tick takes no caller input, returns nothing to a client, and
 * its authority is the enabled policy row itself (written earlier under `manage_infra`)
 * plus the cross-process lease it already holds. Every USER-facing read of the policy
 * goes through {@link getCleanupPolicy}, which gates.
 */
export async function loadCleanupPolicyForScheduler(): Promise<CleanupPolicy> {
  return loadPolicy();
}

/**
 * The servers with a sweep already in flight — session-free, for the same reason as
 * {@link loadCleanupPolicyForScheduler}. The scheduler skips these: two concurrent
 * `docker rmi` sweeps on one host would race each other's candidate lists, and a run
 * that stacks on a stuck one would never be visible as the pile-up it is.
 */
export async function listServersWithCleanupRunning(): Promise<string[]> {
  const rows = await getDb()
    .select({ serverId: dockerCleanupRuns.serverId })
    .from(dockerCleanupRuns)
    .where(eq(dockerCleanupRuns.status, "running"));
  return [...new Set(rows.map((r) => r.serverId).filter((id): id is string => !!id))];
}

/** The history cap AND the read's default page: `3 × serverCount`, floored at
 *  {@link RUNS_KEPT_PER_SERVER} so a zero-server instance still shows the failure rows
 *  it may hold for servers that were since removed. */
async function runHistoryCap(): Promise<number> {
  const servers = await getDb().select({ id: serversTable.id }).from(serversTable);
  return Math.max(RUNS_KEPT_PER_SERVER, servers.length * RUNS_KEPT_PER_SERVER);
}

/**
 * Cleanup history, newest first. NOT team-scoped — servers are the one shared
 * cross-team resource, so a run belongs to a host, not to a team; the gate is the
 * `manage_infra` capability, checked here.
 *
 * The default page is the retention cap itself (3 × the server count) — asking for
 * "the history" answers with everything retention keeps.
 *
 * `seq` breaks same-millisecond ties so the listing is a total order (two servers swept
 * by one tick start in the same millisecond routinely).
 */
export async function listCleanupRuns(
  filter: { serverId?: string; limit?: number } = {},
): Promise<CleanupRunDTO[]> {
  await requireCapability("manage_infra");
  const fallback = filter.limit ?? (await runHistoryCap());
  const limit = clampInt(fallback, 1, MAX_RUN_LIMIT, RUNS_KEPT_PER_SERVER);
  const rows = await getDb()
    .select()
    .from(dockerCleanupRuns)
    .where(filter.serverId ? eq(dockerCleanupRuns.serverId, filter.serverId) : undefined)
    .orderBy(desc(dockerCleanupRuns.startedAt), desc(dockerCleanupRuns.seq))
    .limit(limit);
  if (rows.length === 0) return [];

  const itemRows = await getDb()
    .select()
    .from(dockerCleanupRunItems)
    .where(inArray(dockerCleanupRunItems.runId, rows.map((r) => r.id)));
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
 * Retention: trim the run history to {@link runHistoryCap} — the newest
 * `3 × serverCount` rows — deleting the older TERMINAL rows (their per-scope items go
 * with them via the FK CASCADE). Two rules make this safe rather than merely tidy:
 *
 *  - `running` rows are NEVER deleted, whatever their age: the scheduler's
 *    never-stack-sweeps check and the boot reconcile both read them, and the reconcile
 *    is the one thing allowed to settle a stranded one — retention silently removing
 *    it would un-stick that server by lying instead.
 *  - It runs inside the executor after every sweep (manual and scheduled alike), so
 *    the table is bounded by construction — not by a janitor someone must remember to
 *    schedule for the janitor.
 *
 * Session-free on purpose: its callers are already gated (`runCleanupNow`) or
 * lease-held (the scheduler tick). Exported for tests. Returns how many rows it
 * removed.
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
 * Save the instance-wide policy: the singleton row + a whole-set replace of its scopes
 * (and of the exclusion list, when one is sent) in ONE transaction, so a save is never
 * half-applied — a policy that kept a scope the operator just unchecked would delete
 * things they refused.
 *
 * The cron is REJECTED, not repaired, when it does not parse: `cronMatches` treats an
 * unparseable expression as "never matches" (it must, or one bad row would crash the
 * tick), so an accepted-but-unparseable schedule is a cleanup that silently never runs
 * while the UI says it is enabled. That is the one failure this feature cannot have.
 * The numeric bounds, by contrast, are CLAMPED: there is no dangerous value of
 * "keep N images", only an unhelpful one.
 */
export async function updateCleanupPolicy(
  input: UpdateCleanupPolicyInput,
): Promise<CleanupPolicy> {
  const { teamId } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;

  const schedule = input.schedule.trim();
  if (!parseCron(schedule)) {
    throw new Error(
      `"${schedule}" is not a valid cron expression. Use 5 fields — minute hour day month weekday — e.g. "0 4 * * *" for daily at 04:00 UTC.`,
    );
  }
  const scopes = normalizeScopes(input.scopes);
  // An enabled policy with nothing to reclaim is the same silent lie as an unparseable
  // cron: a job that runs nightly and does nothing, reported as working.
  if (input.enabled && scopes.length === 0) {
    throw new Error("Select at least one thing to reclaim before enabling the scheduled cleanup");
  }
  const minAgeHours = clampInt(input.minAgeHours, 0, MIN_AGE_HOURS_MAX, DEFAULT_MIN_AGE_HOURS);
  const keepImagesPerApp = clampInt(input.keepImagesPerApp, 1, KEEP_IMAGES_MAX, DEFAULT_KEEP_IMAGES_PER_APP);
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
        set: { enabled: input.enabled, schedule, minAgeHours, keepImagesPerApp, updatedAt: now },
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

/* ------------------------------------------------------------------ */
/* The probe                                                           */
/* ------------------------------------------------------------------ */

/**
 * Enumerate what a cleanup WOULD reclaim on `serverId` — the agent's dry run: it lists
 * candidates and removes nothing. Writes NO run row: nothing happened, and a history
 * full of previews would drown the sweeps that did.
 *
 * This is what the UI calls before it opens the confirm dialog, which is the whole
 * point of the feature being trustworthy — the operator approves a LIST, not a verb.
 */
export async function previewCleanup(serverId: string): Promise<CleanupReport> {
  await requireCapability("manage_infra");
  // Team-scoped resolve: a server another team reserved is not this caller's to
  // preview — it reads as "not found", like every other cross-team id.
  const server = await getServer(serverId);
  if (!server) throw new Error("Server not found");
  if (!server.agent?.certFingerprint) throw new Error(notProvisionedMessage(server.name));

  const policy = await loadPolicy();
  const resp = await runAgentCleanup(serverId, {
    scopes: policy.scopes.map((s) => SCOPE_TO_WIRE[s]),
    dryRun: true,
    minAgeHours: policy.minAgeHours,
    keepImagesPerApp: policy.keepImagesPerApp,
  });
  if (!resp.ok) {
    throw new Error(resp.error || "the agent could not enumerate what it would reclaim");
  }
  return {
    serverId,
    serverName: server.name,
    reclaimedBytes: Number(resp.reclaimedBytes ?? 0),
    scopes: toReportScopes(resp.results ?? []),
  };
}

/* ------------------------------------------------------------------ */
/* The executor                                                        */
/* ------------------------------------------------------------------ */

/**
 * The ONE executor every real sweep goes through — the interactive "Clean up now"
 * ({@link runCleanupNow}) and the scheduler ({@link runScheduledCleanup}). Shaped
 * exactly like `executeBackup`, and for the same three reasons:
 *
 *  (a) The `running` run row is written BEFORE the agent is dialled, so a sweep that
 *      could not even start — an unprovisioned host, an agent that is offline or too
 *      old — still lands as a `failed` run. History never lies about an attempt.
 *  (b) The gRPC call runs BETWEEN the two short transactions, never inside one: a
 *      cleanup can take half an hour, and holding a pooled connection + row locks
 *      across it would starve the pool.
 *  (c) `recordActivity` runs OUTSIDE any transaction (its own connection; it deadlocks
 *      pglite otherwise) and is fire-and-forget.
 *
 * Throws on failure — but only AFTER the failed run + the activity are recorded. The
 * throw is for the interactive caller (the UI toasts it verbatim); the scheduler
 * swallows it, because the record it needs already exists.
 */
async function executeCleanup(args: {
  serverId: string;
  serverName: string;
  actor: string;
  trigger: CleanupTrigger;
  policy: CleanupPolicy;
  /** The team the activity row is attributed to; null for a tick, which has no active team. */
  teamId: string | null;
}): Promise<CleanupRunDTO> {
  const { serverId, serverName, actor, trigger, policy, teamId } = args;
  const startedAt = nowIso();
  const runId = newId("dcr");

  // START transaction (short): persist the `running` run. Rule (a).
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

  let failure: string | null = null;
  let reclaimedBytes = 0;
  let items: CleanupRunItem[] = [];
  try {
    // The provisioning check lives HERE, after the run row exists, so a host whose
    // agent never called home leaves the same failed run as one that went offline —
    // and an actionable message, rather than the dial's "not provisioned" internals.
    const server = await getServerById(serverId);
    if (!server) throw new Error("Server not found");
    if (!server.agent?.certFingerprint) throw new Error(notProvisionedMessage(serverName));

    const resp = await runAgentCleanup(serverId, {
      scopes: policy.scopes.map((s) => SCOPE_TO_WIRE[s]),
      dryRun: false,
      minAgeHours: policy.minAgeHours,
      keepImagesPerApp: policy.keepImagesPerApp,
    });
    // A per-scope `error`/`skipped` is NOT a run failure — the agent declines a scope it
    // cannot prove is safe and sweeps the rest. Only `ok:false` (the sweep could not
    // start at all) fails the run, and its partial results are still worth recording.
    items = toRunItems(resp.results ?? []);
    reclaimedBytes = Number(resp.reclaimedBytes ?? 0);
    if (!resp.ok) failure = resp.error || "the agent reported a failed cleanup";
  } catch (e) {
    // Every failure funnels here: unknown/unprovisioned server, AgentUnreachableError,
    // AgentCleanupUnsupportedError ("update the agent on this server"), a docker error
    // the agent reported. runAgentCleanup has already mapped UNIMPLEMENTED, so the
    // message is the one the UI should show.
    failure = e instanceof Error ? e.message : String(e);
  }

  const finishedAt = nowIso();
  // TERMINAL transaction (short): the run's final status + its per-scope breakdown,
  // together — a run that reports bytes with no lines, or lines with no status, is a
  // half-truth. Rule (b): the agent call is already done, outside any tx.
  const finished = await getDb().transaction(async (tx): Promise<CleanupRunDTO> => {
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
  });

  // Retention rides the executor: every finished sweep — success or failure — trims
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
  // first team — the same compromise the nightly backup makes.
  await recordActivity(
    "cleanup",
    failure
      ? `Docker cleanup on ${serverName} failed: ${failure}`
      : `Docker cleanup on ${serverName} reclaimed ${formatBytes(reclaimedBytes)}`,
    actor,
    null,
    teamId,
  );

  if (failure) throw new Error(failure);
  return finished;
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

/**
 * Reclaim Docker disk on one server NOW, with the instance policy's scopes. Interactive
 * and deliberately per-server: it ignores {@link dockerCleanupExcludedServers}, because
 * an operator standing in front of the button has already made the decision that list
 * exists to encode, and it runs whether or not the SCHEDULE is enabled.
 *
 * THROWS on failure (after recording it) so the UI can toast the agent's message
 * verbatim — "update the agent on this server" must reach the person who can act on it.
 */
export async function runCleanupNow(serverId: string): Promise<CleanupRunDTO> {
  const { teamId } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  // Team-scoped resolve: a destructive prune on a host reserved for another
  // team must read as "not found" (the scheduler's session-free path keeps the
  // unscoped getServerById inside the executor).
  const server = await getServer(serverId);
  if (!server) throw new Error("Server not found");

  const policy = await loadPolicy();
  // Fail fast rather than record a run that asks the agent for nothing: an empty scope
  // set is an ok response with zero bytes, indistinguishable from a sweep that worked.
  if (policy.scopes.length === 0) {
    throw new Error("No cleanup scopes are selected — choose what to reclaim, then clean up");
  }
  return executeCleanup({
    serverId,
    serverName: server.name,
    actor: user.name,
    trigger: "manual",
    policy,
    teamId,
  });
}

/**
 * The session-free twin of {@link runCleanupNow}, for the scheduler tick. There is no
 * request context to gate on: the tick has already claimed the cross-process lease and
 * read the enabled policy straight off the store, so its authority is that policy row
 * (written earlier under `manage_infra`) and a synthetic "Scheduler" actor.
 *
 * NEVER throws. {@link executeCleanup} has already recorded the `failed` run and the
 * activity by the time it does; swallowing here is what stops one unreachable host from
 * aborting the rest of the tick's servers.
 */
export async function runScheduledCleanup(
  serverId: string,
  serverName: string,
  policy: CleanupPolicy,
): Promise<void> {
  try {
    await executeCleanup({
      serverId,
      serverName,
      actor: "Scheduler",
      trigger: "scheduled",
      policy,
      teamId: null,
    });
  } catch {
    // The run row + the activity already tell this story; the re-thrown error is for
    // the interactive caller, not for a tick with nobody to tell.
  }
}

/** Servers with a deploy-triggered sweep in flight — a second one would only race the
 *  first's candidate list; the next deploy catches anything it missed. */
const deploySweepInFlight = new Set<string>();

/**
 * Snapshot of {@link deploySweepInFlight}, for the scheduler's never-stack-sweeps
 * check: the deploy-time sweep writes NO run row on purpose, so without this
 * in-process signal a tick could start a scheduled sweep on a host whose images a
 * deploy-sweep is mid-`rmi` on — harmless on disk (the agent skips a failed rmi and
 * moves on) but it would land a cosmetic error line in the run history. In-memory is
 * the right scope: the deploy queue and the scheduler run in the same process, and
 * on a horizontally-scaled control plane the lease already serializes the ticks.
 */
export function serversWithDeploySweepInFlight(): string[] {
  return [...deploySweepInFlight];
}

/**
 * Remove the superseded app images a deploy just left behind on `serverId` — the
 * deploy-time half of app-image retention. The nightly sweep alone cannot keep a
 * fast-iterating host inside its disk: a day of redeploys at 1-2GB per image
 * accumulates tens of GB BETWEEN ticks (measured: 24 superseded images / 39GB in
 * 30h on one host), so the moment that mints a new image is the moment the old
 * ones beyond `keepImagesPerApp` must go.
 *
 * Scope is `unused_app_images` ONLY — the cache scopes stay on the schedule where
 * their age filter belongs. The operator's controls are respected: the scope
 * being unchecked in the policy turns this off, and an excluded server is skipped
 * (exclusion means "hands off this host's Docker", and nobody is standing in
 * front of a button here — unlike {@link runCleanupNow}, which ignores the list).
 *
 * Writes NO run row and NO activity: this is deploy hygiene, as much a part of
 * the deploy as removing the old container — recording ~26 rows/day per busy app
 * would evict the real history (capped at 3×servers) and spam the feed. The
 * deploy log carries the outcome instead (the caller logs what we return).
 *
 * Session-free and NEVER throws: it runs after the deploy already succeeded, and
 * a failed sweep must not fail a shipped deploy. Returns the freed bytes (0 when
 * skipped or failed) so the deploy log can mention it.
 */
export async function sweepSupersededAppImages(serverId: string): Promise<number> {
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
    });
    if (!resp.ok) {
      console.warn(`[cleanup] deploy-time image sweep on ${serverId} failed: ${resp.error || "unknown"}`);
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
 * Settle cleanup runs orphaned by a control-plane restart — the cleanup analogue of
 * `reconcileInFlightBackupRuns`. A run is persisted `running` before a call that can
 * take half an hour and is only flipped at the terminal transaction; if the process
 * dies in between, the row is stuck `running` forever — and the scheduler's
 * never-stack-runs check would then skip that server for good.
 *
 * Run once at boot (instrumentation.ts) and safe to call again: it only touches runs
 * older than {@link CLEANUP_ORPHAN_AFTER_MS}, so it can never race a live sweep. One
 * statement, so no transaction — unlike the backup reconcile there is no denormalized
 * `lastStatus` to settle alongside (the policy deliberately carries none: the runs ARE
 * the source of truth, so they cannot drift from themselves).
 *
 * Session-free by construction: a boot hook has no user to gate. It takes no input and
 * only settles rows that are already stranded.
 */
export async function reconcileInFlightCleanupRuns(): Promise<number> {
  const cutoffIso = new Date(Date.now() - CLEANUP_ORPHAN_AFTER_MS).toISOString();
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
  }
  return flipped.length;
}
