import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";

export const PREVIEW_MAX_ACTIVE_DEFAULT = 3;

export const PREVIEW_TTL_DAYS_DEFAULT = 3;

export type PreviewForkPolicy = "deny" | "approve" | "allow";

export function forkPolicyOf(
  value: string | null | undefined,
): PreviewForkPolicy {
  return value === "deny" || value === "allow" ? value : "approve";
}

export async function previewSettings(appId: string): Promise<{
  enabled: boolean;
  baseDomain: string | null;
  maxActive: number;
  ttlDays: number;
  forkPolicy: PreviewForkPolicy;
  serverId: string | null;
  https: boolean;
  autoDeploy: boolean;
  port: number | null;
  buildDrafts: boolean;
  comment: boolean;
  requiredLabels: string[];
} | null> {
  const rows = await getDb()
    .select({
      enabled: appsTable.previewEnabled,
      baseDomain: appsTable.previewBaseDomain,
      maxActive: appsTable.previewMaxActive,
      ttlDays: appsTable.previewTtlDays,
      forkPolicy: appsTable.previewForkPolicy,
      serverId: appsTable.previewServerId,
      https: appsTable.previewHttps,
      autoDeploy: appsTable.previewAutoDeploy,
      port: appsTable.previewPort,
      buildDrafts: appsTable.previewBuildDrafts,
      comment: appsTable.previewComment,
      requiredLabels: appsTable.previewRequiredLabels,
    })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    enabled: r.enabled,
    baseDomain: r.baseDomain,
    maxActive:
      r.maxActive && r.maxActive > 0 ? r.maxActive : PREVIEW_MAX_ACTIVE_DEFAULT,
    ttlDays: r.ttlDays && r.ttlDays > 0 ? r.ttlDays : PREVIEW_TTL_DAYS_DEFAULT,
    forkPolicy: forkPolicyOf(r.forkPolicy),
    serverId: r.serverId,
    https: Boolean(r.https) && Boolean(r.baseDomain?.trim()),
    autoDeploy: r.autoDeploy,
    port: r.port && r.port > 0 ? r.port : null,
    buildDrafts: r.buildDrafts,
    comment: r.comment,
    requiredLabels: parseRequiredLabels(r.requiredLabels),
  };
}

export function parseRequiredLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split("\n")
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
