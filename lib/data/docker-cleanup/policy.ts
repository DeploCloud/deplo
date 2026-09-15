import "server-only";

import { eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  dockerCleanupExcludedServers,
  dockerCleanupPolicy,
  dockerCleanupPolicyScopes,
} from "../../db/schema/control-plane/docker-cleanup";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { recordActivity } from "../activity";
import { getServerById } from "../servers/roster";
import { parseCron } from "../../backups/cron";
import {
  CLEANUP_SCOPES,
  effectiveScopes,
  normalizeScopes,
  type CleanupScopeId,
} from "./scopes";

const POLICY_ID = "default";

export interface CleanupPolicy {
  enabled: boolean;
  schedule: string;
  minAgeHours: number;
  keepImagesPerApp: number;
  scopes: CleanupScopeId[];
  excludedServerIds: string[];
  updatedAt: string | null;
}

export interface UpdateCleanupPolicyInput {
  enabled: boolean;
  schedule: string;
  minAgeHours: number;
  keepImagesPerApp: number;
  scopes: CleanupScopeId[];
  excludedServerIds?: string[];
}

const DEFAULT_SCHEDULE = "0 4 * * *";
const DEFAULT_MIN_AGE_HOURS = 24;
const DEFAULT_KEEP_IMAGES_PER_APP = 1;

const DEFAULT_SCOPES: CleanupScopeId[] = [...CLEANUP_SCOPES];

const MIN_AGE_HOURS_MAX = 8760;
const KEEP_IMAGES_MAX = 20;

export function clampInt(
  n: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function loadPolicy(): Promise<CleanupPolicy> {
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
    scopes: effectiveScopes(
      scopeRows.map((r) => r.scope),
      row.updatedAt,
    ),
    excludedServerIds,
    updatedAt: row.updatedAt,
  };
}

export async function getCleanupPolicy(): Promise<CleanupPolicy> {
  await requireInstanceAdmin();
  return loadPolicy();
}

export async function loadCleanupPolicyForScheduler(): Promise<CleanupPolicy> {
  return loadPolicy();
}

export async function updateCleanupPolicy(
  input: UpdateCleanupPolicyInput,
): Promise<CleanupPolicy> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const schedule = input.schedule.trim();
  if (!parseCron(schedule)) {
    throw new Error(
      `"${schedule}" is not a valid cron expression. Use 5 fields, minute hour day month weekday, e.g. "0 4 * * *" for daily at 04:00 UTC.`,
    );
  }
  const scopes = normalizeScopes(input.scopes);
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
