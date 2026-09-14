import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";

// How many previews one app may have open at once when it sets no limit.
export const PREVIEW_MAX_ACTIVE_DEFAULT = 3;

// Idle days before the reaper closes a preview, when the app sets no limit.
export const PREVIEW_TTL_DAYS_DEFAULT = 3;

// How Deplo treats a pull request opened from a fork.
export type PreviewForkPolicy = "deny" | "approve" | "allow";

// NULL in the column ⇒ the safe middle: visible, but never built unasked.
export function forkPolicyOf(
  value: string | null | undefined,
): PreviewForkPolicy {
  return value === "deny" || value === "allow" ? value : "approve";
}

// The effective preview settings for an app (NULL columns ⇒ the defaults).
export async function previewSettings(appId: string): Promise<{
  enabled: boolean;
  baseDomain: string | null;
  maxActive: number;
  ttlDays: number;
  forkPolicy: PreviewForkPolicy;
  // Where previews run. NULL ⇒ the app's own server.
  serverId: string | null;
  // HTTPS on preview hosts. Forced OFF without a base domain - see below.
  https: boolean;
  // Rebuild when the pull request receives a new commit.
  autoDeploy: boolean;
  // Container port. NULL ⇒ the app's build port.
  port: number | null;
  // Build a pull request while it is still a draft.
  buildDrafts: boolean;
  // Post and keep updating the sticky comment on the pull request.
  comment: boolean;
  // A pull request must carry ONE of these to get a preview. Empty ⇒ no filter.
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
    // Coerced, not merely read: a nip.io host cannot hold a certificate, so without a
    // base domain the answer is no whatever the column says.
    https: Boolean(r.https) && Boolean(r.baseDomain?.trim()),
    autoDeploy: r.autoDeploy,
    port: r.port && r.port > 0 ? r.port : null,
    buildDrafts: r.buildDrafts,
    comment: r.comment,
    requiredLabels: parseRequiredLabels(r.requiredLabels),
  };
}

// Split the stored newline list into the labels a pull request may match. Lower-cased
// because GitHub labels are case-insensitive, so no comparison site has to remember.
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
