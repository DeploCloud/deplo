import {
  dockerCleanupExcludedServers,
  dockerCleanupPolicy,
  dockerCleanupPolicyScopes,
  dockerCleanupRunItems,
  dockerCleanupRuns,
} from "../db/schema/control-plane/docker-cleanup";
import type { TestDb } from "../db/test-harness";
import type {
  CleanupRunItem,
  CleanupRunStatus,
  CleanupTrigger,
} from "./docker-cleanup/scopes";
import { SERVER_1 } from "./app-graph-test-helpers";

const T0 = "2026-01-01T00:00:00.000Z";

export const CLEANUP_POLICY_ID = "default";

export const TRUNCATE_CLEANUP = `truncate table
  docker_cleanup_run_items, docker_cleanup_runs,
  docker_cleanup_policy_scopes, docker_cleanup_excluded_servers, docker_cleanup_policy
  restart identity cascade;`;

export interface SeedCleanupPolicyOpts {
  enabled?: boolean;
  schedule?: string;
  minAgeHours?: number;
  keepImagesPerApp?: number;
  scopes?: string[];
  excludedServerIds?: string[];
  updatedAt?: string;
}

export async function seedCleanupPolicy(
  db: TestDb,
  opts: SeedCleanupPolicyOpts = {},
): Promise<void> {
  const scopes = opts.scopes ?? [
    "build_cache",
    "dangling_images",
    "orphan_volumes",
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
  finishedAt?: string | null;
  items?: CleanupRunItem[];
}

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
