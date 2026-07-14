import {
  dockerCleanupExcludedServers,
  dockerCleanupPolicy,
  dockerCleanupPolicyScopes,
  dockerCleanupRunItems,
  dockerCleanupRuns,
} from "../db/schema/control-plane";
import type { TestDb } from "../db/test-harness";
import type {
  CleanupRunItem,
  CleanupRunStatus,
  CleanupScopeId,
  CleanupTrigger,
} from "./docker-cleanup";
import { SERVER_1 } from "./app-graph-test-helpers";

/**
 * Shared seeding for the Docker-cleanup tables (the data layer + the scheduler both
 * read pglite). Pair with `seedServer` (every run's `server_id` FK, and the exclusion
 * list's) and `seedIdentity` (the activity rows the executor writes), and drive the
 * data functions inside `runWithIdentity({ userId, teamId })`.
 *
 * Nothing here is team-scoped: servers are the one shared cross-team resource, so the
 * policy, the runs and the exclusions are all instance-wide infra state.
 *
 * The types come from `./docker-cleanup` as TYPE-ONLY imports, so this helper never
 * pulls the `server-only` data module into the test process at runtime.
 *
 * Not named `*.test.ts` so the `node --test` glob skips it (a helper).
 */

const T0 = "2026-01-01T00:00:00.000Z";

/** The singleton policy row's PK (mirrors `POLICY_ID` in the data layer). */
export const CLEANUP_POLICY_ID = "default";

/** Truncate every Docker-cleanup table (call in `beforeEach` before seeding).
 *  `restart identity` resets `docker_cleanup_runs.seq`, so a test can assert the
 *  newest-first ordering of runs it seeds in a known order. */
export const TRUNCATE_CLEANUP = `truncate table
  docker_cleanup_run_items, docker_cleanup_runs,
  docker_cleanup_policy_scopes, docker_cleanup_excluded_servers, docker_cleanup_policy
  restart identity cascade;`;

export interface SeedCleanupPolicyOpts {
  enabled?: boolean;
  schedule?: string;
  minAgeHours?: number;
  keepImagesPerApp?: number;
  /** Defaults to the three scopes that cannot strand an app (`unused_app_images` is opt-in). */
  scopes?: CleanupScopeId[];
  /** Servers the SCHEDULED sweep skips. Seed the servers first — this FKs to them. */
  excludedServerIds?: string[];
  updatedAt?: string;
}

/**
 * Seed the singleton policy + its scopes junction (+ any exclusions). Omit it entirely
 * to test the missing-row path — a never-configured instance reads as the defaults.
 */
export async function seedCleanupPolicy(
  db: TestDb,
  opts: SeedCleanupPolicyOpts = {},
): Promise<void> {
  const scopes = opts.scopes ?? [
    "build_cache",
    "dangling_images",
    "orphan_buildkit_cache",
  ];
  await db
    .insert(dockerCleanupPolicy)
    .values({
      id: CLEANUP_POLICY_ID,
      enabled: opts.enabled ?? true,
      schedule: opts.schedule ?? "0 4 * * *",
      minAgeHours: opts.minAgeHours ?? 168,
      keepImagesPerApp: opts.keepImagesPerApp ?? 1,
      createdAt: T0,
      updatedAt: opts.updatedAt ?? T0,
    })
    .onConflictDoNothing();
  if (scopes.length > 0) {
    await db
      .insert(dockerCleanupPolicyScopes)
      .values(scopes.map((scope) => ({ policyId: CLEANUP_POLICY_ID, scope })))
      .onConflictDoNothing();
  }
  if (opts.excludedServerIds?.length) {
    await seedCleanupExclusions(db, opts.excludedServerIds);
  }
}

/** Seed the scheduled sweep's opt-out list (the servers must already exist). */
export async function seedCleanupExclusions(
  db: TestDb,
  serverIds: string[],
): Promise<void> {
  if (serverIds.length === 0) return;
  await db
    .insert(dockerCleanupExcludedServers)
    .values(serverIds.map((serverId) => ({ serverId })))
    .onConflictDoNothing();
}

export interface SeedCleanupRunOpts {
  id: string;
  serverId?: string | null;
  serverName?: string;
  trigger?: CleanupTrigger;
  actor?: string;
  status?: CleanupRunStatus;
  error?: string | null;
  reclaimedBytes?: number;
  startedAt?: string;
  /** Null while `running` — that is exactly the shape the boot reconcile settles. */
  finishedAt?: string | null;
  /** The per-scope breakdown. `(run_id, scope)` is the PK, so no scope twice. */
  items?: CleanupRunItem[];
}

/** Seed one cleanup RUN (history), plus its per-scope items. `seq` is DB-assigned. */
export async function seedCleanupRun(
  db: TestDb,
  opts: SeedCleanupRunOpts,
): Promise<string> {
  const status = opts.status ?? "success";
  const serverId = opts.serverId === undefined ? SERVER_1 : opts.serverId;
  await db.insert(dockerCleanupRuns).values({
    id: opts.id,
    serverId,
    serverName: opts.serverName ?? serverId ?? "removed-server",
    trigger: opts.trigger ?? "manual",
    actor: opts.actor ?? "Tester",
    status,
    error: opts.error ?? null,
    reclaimedBytes: opts.reclaimedBytes ?? 0,
    startedAt: opts.startedAt ?? T0,
    // A `running` run has no finish; anything terminal does unless the test says so.
    finishedAt:
      opts.finishedAt === undefined
        ? status === "running"
          ? null
          : (opts.startedAt ?? T0)
        : opts.finishedAt,
  });
  if (opts.items?.length) {
    await db.insert(dockerCleanupRunItems).values(
      opts.items.map((i) => ({
        runId: opts.id,
        scope: i.scope,
        reclaimedBytes: i.reclaimedBytes,
        itemsRemoved: i.itemsRemoved,
        skipped: i.skipped,
        error: i.error,
      })),
    );
  }
  return opts.id;
}
