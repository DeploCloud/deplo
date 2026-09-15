import "server-only";

import { cache } from "@/lib/request-cache";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { teamAppOrder } from "../../db/schema/control-plane/display-order";
import {
  isInstanceAdmin,
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../../membership";
import { matchesQuery } from "../../match-query";
import { inAppScope } from "../../auth/request-context";
import {
  loadAppGraph,
  loadAppGraphBySlug,
  loadAppsByTeam,
  loadTeamApp,
  preloadSummaries,
} from "../app-graph-load";
import {
  appCapabilities,
  appCapabilitiesForTeam,
  nodeCapabilitiesFor,
} from "../node-access";
import { summarize, summarizeOne, type AppSummary } from "./summary";
import type { App } from "../../types/app";

async function appOrderRank(teamId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ appId: teamAppOrder.appId, position: teamAppOrder.position })
    .from(teamAppOrder)
    .where(eq(teamAppOrder.teamId, teamId));
  return new Map(rows.map((r) => [r.appId, r.position] as const));
}

export async function listApps(query?: string): Promise<AppSummary[]> {
  const teamId = await requireActiveTeamId();
  const [all, rank] = await Promise.all([
    loadAppsByTeam(teamId),
    appOrderRank(teamId),
  ]);

  const scoped = all.filter((p) => inAppScope(p) && !p.deletingAt);
  const reach = await appCapabilitiesForTeam(
    teamId,
    scoped.map((p) => ({
      id: p.id,
      folderId: p.folderId ?? null,
      projectId: p.projectId ?? null,
      environmentId: p.environmentId ?? null,
    })),
  );
  const proj = scoped.filter((p) => (reach.get(p.id)?.length ?? 0) > 0);
  const hits = query
    ? proj.filter((p) => matchesQuery(query, p.name, p.slug, p.id))
    : proj;
  const pre = await preloadSummaries(hits);
  return hits
    .map((p) => ({ ...summarize(p, pre), capabilities: reach.get(p.id) }))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
}

export async function reorderApps(orderedIds: string[]): Promise<void> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("the team-wide app order");
  if (!(await isInstanceAdmin())) {
    await requireCapability("manage_team");
  }
  await getDb().transaction(async (tx) => {
    const teamAppIds = (
      await tx
        .select({ id: appsTable.id })
        .from(appsTable)
        .where(eq(appsTable.teamId, teamId))
    ).map((r) => r.id);
    const valid = new Set(teamAppIds);
    const seen = new Set<string>();
    const next: string[] = [];
    for (const id of orderedIds) {
      if (valid.has(id) && !seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
    }
    for (const id of teamAppIds) if (!seen.has(id)) next.push(id);
    await tx.delete(teamAppOrder).where(eq(teamAppOrder.teamId, teamId));
    if (next.length > 0) {
      await tx
        .insert(teamAppOrder)
        .values(next.map((appId, position) => ({ teamId, appId, position })));
    }
  });
}

export const getAppBySlug = cache(async function getAppBySlug(
  slug: string,
): Promise<AppSummary | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadAppGraphBySlug(slug);
  return p && p.teamId === teamId && inAppScope(p) && (await canReachApp(p.id))
    ? summarizeOne(p)
    : null;
});

export async function getAppById(id: string): Promise<App | null> {
  const p = await loadTeamApp(id, await requireActiveTeamId());
  return p && (await canReachApp(p.id)) ? p : null;
}

async function canReachApp(id: string): Promise<boolean> {
  return (await appCapabilities(id)).length > 0;
}

async function reachableByUser(
  userId: string,
  teamId: string,
  appId: string,
): Promise<boolean> {
  return (
    (await nodeCapabilitiesFor(userId, teamId, { kind: "app", id: appId }))
      .length > 0
  );
}

export async function summarizeForTeam(
  id: string,
  teamId: string,
  userId: string,
): Promise<AppSummary | null> {
  const p = await loadAppGraph(id);
  return p &&
    p.teamId === teamId &&
    inAppScope(p) &&
    (await reachableByUser(userId, teamId, p.id))
    ? summarizeOne(p)
    : null;
}

export async function findAppSummaryBySlugForTeam(
  slug: string,
  teamId: string,
  userId: string,
): Promise<AppSummary | null> {
  const p = await loadAppGraphBySlug(slug);
  return p &&
    p.teamId === teamId &&
    inAppScope(p) &&
    (await reachableByUser(userId, teamId, p.id))
    ? summarizeOne(p)
    : null;
}
