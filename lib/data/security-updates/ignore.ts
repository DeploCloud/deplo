import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { apps } from "../../db/schema/control-plane/apps";
import {
  securityFindings,
  securityIgnores,
  workloadImages,
} from "../../db/schema/control-plane/security-updates";
import { newId, nowIso } from "../../ids";
import { requireCapability } from "../../membership";
import { joinNames } from "../../utils";
import { recordActivity } from "../activity";
import { getDatabase } from "../databases/rows";
import { requireAppCapability } from "../node-access";

export const IGNORE_DAYS = [30, 90, 180] as const;
const VULN_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const MAX_REASON = 500;

export interface IgnoreTarget {
  appId?: string | null;
  databaseId?: string | null;
  vulnIds: string[];
}

// Both gates: the field's authScopes, and here the Capability inside the app's folder or team-wide.
async function resolveTarget(t: IgnoreTarget) {
  const vulnIds = [...new Set(t.vulnIds)];
  if (vulnIds.length === 0 || vulnIds.length > 500)
    throw new Error("Name between 1 and 500 advisories");
  if (!vulnIds.every((v) => VULN_ID.test(v)))
    throw new Error("That is not an advisory id");
  if (Boolean(t.appId) === Boolean(t.databaseId))
    throw new Error("Name exactly one app or database");
  if (t.appId) {
    const { teamId } = await requireAppCapability(
      t.appId,
      "ignore_security_updates",
    );
    const [app] = await getDb()
      .select({ name: apps.name })
      .from(apps)
      .where(and(eq(apps.id, t.appId), eq(apps.teamId, teamId)))
      .limit(1);
    if (!app) throw new Error("App not found");
    return {
      teamId,
      appId: t.appId,
      databaseId: null,
      name: app.name,
      vulnIds,
    };
  }
  const { teamId } = await requireCapability("ignore_security_updates");
  const db = await getDatabase(t.databaseId!);
  if (!db || db.teamId !== teamId) throw new Error("Database not found");
  return { teamId, appId: null, databaseId: db.id, name: db.name, vulnIds };
}

function subjectOf(appId: string | null, databaseId: string | null) {
  return and(
    appId ? eq(securityIgnores.appId, appId) : isNull(securityIgnores.appId),
    databaseId
      ? eq(securityIgnores.databaseId, databaseId)
      : isNull(securityIgnores.databaseId),
  );
}

// "the openssl security update", or "3 security updates", for the Activity line.
async function describe(
  teamId: string,
  appId: string | null,
  databaseId: string | null,
  vulnIds: string[],
): Promise<string> {
  const rows = await getDb()
    .selectDistinct({ name: securityFindings.packageName })
    .from(securityFindings)
    .innerJoin(
      workloadImages,
      and(
        eq(workloadImages.serverId, securityFindings.serverId),
        eq(workloadImages.workloadId, securityFindings.workloadId),
        eq(workloadImages.service, securityFindings.service),
      ),
    )
    .where(
      and(
        eq(workloadImages.teamId, teamId),
        appId
          ? and(eq(workloadImages.kind, "app"), eq(workloadImages.appId, appId))
          : eq(workloadImages.databaseId, databaseId!),
        inArray(securityFindings.vulnId, vulnIds),
      ),
    );
  const names = rows.map((r) => r.name).sort();
  if (names.length === 0)
    return vulnIds.length === 1 ? vulnIds[0] : `${vulnIds.length} advisories`;
  return `the ${joinNames(names)} security ${names.length === 1 ? "update" : "updates"}`;
}

export async function ignoreSecurityUpdate(
  t: IgnoreTarget & { reason?: string | null; days?: number | null },
): Promise<void> {
  const target = await resolveTarget(t);
  const days = t.days ?? 90;
  if (!(IGNORE_DAYS as readonly number[]).includes(days))
    throw new Error("Ignore for 30, 90 or 180 days");
  const reason = (t.reason ?? "").trim().slice(0, MAX_REASON);
  const user = (await getCurrentUser())!;
  const now = nowIso();
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  await getDb()
    .insert(securityIgnores)
    .values(
      target.vulnIds.map((vulnId) => ({
        id: newId("sig"),
        teamId: target.teamId,
        appId: target.appId,
        databaseId: target.databaseId,
        vulnId,
        reason,
        expiresAt,
        createdBy: user.name,
        createdByUserId: user.id,
        createdAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        securityIgnores.appId,
        securityIgnores.databaseId,
        securityIgnores.vulnId,
      ],
      set: {
        reason,
        expiresAt,
        createdBy: user.name,
        createdByUserId: user.id,
        createdAt: now,
      },
    });
  const what = await describe(
    target.teamId,
    target.appId,
    target.databaseId,
    target.vulnIds,
  );
  await recordActivity(
    "security_update",
    `Ignored ${what} in ${target.name} until ${expiresAt.slice(0, 10)}${reason ? `: ${reason}` : ""}`,
    user.name,
    target.appId,
    target.teamId,
    null,
    target.databaseId,
  );
}

export async function unignoreSecurityUpdate(t: IgnoreTarget): Promise<void> {
  const target = await resolveTarget(t);
  const user = (await getCurrentUser())!;
  const removed = await getDb()
    .delete(securityIgnores)
    .where(
      and(
        eq(securityIgnores.teamId, target.teamId),
        subjectOf(target.appId, target.databaseId),
        inArray(securityIgnores.vulnId, target.vulnIds),
      ),
    )
    .returning({ id: securityIgnores.id });
  if (removed.length === 0) return;
  const what = await describe(
    target.teamId,
    target.appId,
    target.databaseId,
    target.vulnIds,
  );
  await recordActivity(
    "security_update",
    `Stopped ignoring ${what} in ${target.name}`,
    user.name,
    target.appId,
    target.teamId,
    null,
    target.databaseId,
  );
}
