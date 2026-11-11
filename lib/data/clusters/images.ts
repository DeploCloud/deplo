import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterImageCopies,
  clusterMembers as clusterMembersTable,
} from "../../db/schema/control-plane/clusters";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { nowIso } from "../../ids";
import { copyClusterImage } from "../../infra/agent-client/cluster-host";
import { requireActiveTeamId } from "../../membership";
import type { ClusterImageProgress } from "../../types/cluster";
import { instanceFrozen } from "../deplo-move/freeze";
import { withKeyedLock } from "../keyed-mutex";
import { fingerprintOf } from "./relay";

/** Releases of an App each member keeps: the current one and the one before, for rollback. */
export const IMAGE_RELEASES_KEPT = 2;

type Member = { serverId: string; arch: string };

/** A release Deplo built itself; a pulled image comes from its registry on any member and needs no copy. */
export function isBuiltImage(ref: string): boolean {
  return ref.startsWith("deplo/");
}

const inFlight = new Set<string>();

async function members(clusterId: string): Promise<Member[]> {
  const rows = await getDb()
    .select({
      serverId: clusterMembersTable.serverId,
      arch: serversTable.hostArch,
      emptying: clusterMembersTable.emptyingSince,
    })
    .from(clusterMembersTable)
    .innerJoin(serversTable, eq(serversTable.id, clusterMembersTable.serverId))
    .where(eq(clusterMembersTable.clusterId, clusterId))
    .orderBy(
      asc(clusterMembersTable.joinedAt),
      asc(clusterMembersTable.serverId),
    );
  return rows
    .filter((r) => !r.emptying)
    .map((r) => ({ serverId: r.serverId, arch: r.arch }));
}

async function setCopy(
  appId: string,
  imageRef: string,
  serverId: string,
  state: "copying" | "held" | "failed",
  error = "",
  current = false,
): Promise<void> {
  const now = nowIso();
  await getDb()
    .insert(clusterImageCopies)
    .values({
      appId,
      imageRef,
      serverId,
      state,
      error,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        clusterImageCopies.appId,
        clusterImageCopies.imageRef,
        clusterImageCopies.serverId,
      ],
      set: {
        state,
        error,
        updatedAt: now,
        ...(current ? { createdAt: now } : {}),
      },
    });
}

async function forget(
  appId: string,
  serverId: string,
  imageRefs: string[],
): Promise<void> {
  if (imageRefs.length === 0) return;
  await getDb()
    .delete(clusterImageCopies)
    .where(
      and(
        eq(clusterImageCopies.appId, appId),
        eq(clusterImageCopies.serverId, serverId),
        inArray(clusterImageCopies.imageRef, imageRefs),
      ),
    );
}

/** The source keeps its own releases by the usual cleanup; the record follows the same last-two rule. */
async function trimReleases(appId: string, serverId: string): Promise<void> {
  const rows = await getDb()
    .select({ ref: clusterImageCopies.imageRef })
    .from(clusterImageCopies)
    .where(
      and(
        eq(clusterImageCopies.appId, appId),
        eq(clusterImageCopies.serverId, serverId),
      ),
    )
    .orderBy(
      desc(clusterImageCopies.createdAt),
      desc(clusterImageCopies.imageRef),
    );
  await forget(
    appId,
    serverId,
    rows.slice(IMAGE_RELEASES_KEPT).map((r) => r.ref),
  );
}

function message(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * Copies one release from the server that holds it to every other member of its architecture, one at a time, and
 * records who holds it. A failure is recorded against that member and never stops the others.
 */
export async function copyReleaseToMembers(
  appId: string,
  imageRef: string,
  sourceServerId: string,
): Promise<void> {
  if (inFlight.has(appId)) return;
  inFlight.add(appId);
  try {
    await withKeyedLock(`cluster-images:${appId}`, async () => {
      if (await instanceFrozen()) return;
      const app = (
        await getDb()
          .select({ clusterId: appsTable.clusterId })
          .from(appsTable)
          .where(eq(appsTable.id, appId))
          .limit(1)
      )[0];
      if (!app?.clusterId) return;
      const all = await members(app.clusterId);
      const source = all.find((m) => m.serverId === sourceServerId);
      // An unknown architecture is never assumed to match another.
      if (!source || !source.arch) return;
      const targets = all.filter(
        (m) => m.serverId !== source.serverId && m.arch === source.arch,
      );
      // The release a deploy just made (or rolled back to) is the newest, whatever its first copy date.
      await setCopy(appId, imageRef, source.serverId, "held", "", true);
      await trimReleases(appId, source.serverId);
      const have = new Set(
        (
          await getDb()
            .select({ serverId: clusterImageCopies.serverId })
            .from(clusterImageCopies)
            .where(
              and(
                eq(clusterImageCopies.appId, appId),
                eq(clusterImageCopies.imageRef, imageRef),
                eq(clusterImageCopies.state, "held"),
              ),
            )
        ).map((r) => r.serverId),
      );
      const todo = targets.filter((t) => !have.has(t.serverId));
      for (const t of todo)
        await setCopy(appId, imageRef, t.serverId, "copying");
      for (const t of todo) {
        if (await instanceFrozen()) return;
        try {
          const fingerprint = await fingerprintOf(t.serverId);
          if (!fingerprint)
            throw new Error("This server has no certificate yet.");
          const r = await copyClusterImage(
            source.serverId,
            imageRef,
            fingerprint,
            IMAGE_RELEASES_KEPT,
          );
          await forget(appId, t.serverId, r.pruned);
          await setCopy(appId, imageRef, t.serverId, "held");
        } catch (e) {
          console.warn(
            `[cluster-images] ${appId} ${imageRef} -> ${t.serverId}: ${message(e)}`,
          );
          await setCopy(appId, imageRef, t.serverId, "failed", message(e));
        }
      }
    });
  } finally {
    inFlight.delete(appId);
  }
}

/**
 * The deploy's tail for a cluster App: copy the release it just built to the other members, in the background.
 * Off the deploy's lane on purpose and never throws, since the deploy already succeeded.
 */
export function copyImageAfterDeploy(depId: string, serverId: string): void {
  void (async () => {
    if (await instanceFrozen()) return;
    const dep = (
      await getDb()
        .select({
          appId: deploymentsTable.appId,
          imageRef: deploymentsTable.imageRef,
          previewId: deploymentsTable.previewId,
        })
        .from(deploymentsTable)
        .where(eq(deploymentsTable.id, depId))
        .limit(1)
    )[0];
    // A preview never fails over, and its build is not one of the App's releases (#212).
    if (dep?.previewId) return;
    if (!dep?.imageRef || !isBuiltImage(dep.imageRef)) return;
    await copyReleaseToMembers(dep.appId, dep.imageRef, serverId);
  })().catch((e) => console.warn(`[cluster-images] ${depId}: ${message(e)}`));
}

/** Members that hold a release, for the placement rule: a member still copying is not a target. */
export async function membersHoldingImage(
  appId: string,
  imageRef: string,
): Promise<string[]> {
  const rows = await getDb()
    .select({ serverId: clusterImageCopies.serverId })
    .from(clusterImageCopies)
    .where(
      and(
        eq(clusterImageCopies.appId, appId),
        eq(clusterImageCopies.imageRef, imageRef),
        eq(clusterImageCopies.state, "held"),
      ),
    );
  return rows.map((r) => r.serverId);
}

type Latest = { appId: string; clusterId: string; ref: string; source: string };

/** Each cluster App's newest recorded release and a server that holds it. */
async function latestReleases(
  clusterId?: string,
  teamId?: string,
): Promise<Latest[]> {
  const apps = await getDb()
    .select({
      id: appsTable.id,
      clusterId: appsTable.clusterId,
      serverId: appsTable.serverId,
    })
    .from(appsTable)
    .where(
      and(
        clusterId ? eq(appsTable.clusterId, clusterId) : undefined,
        teamId ? eq(appsTable.teamId, teamId) : undefined,
      ),
    );
  const mine = apps.filter((a) => a.clusterId);
  if (mine.length === 0) return [];
  const rows = await getDb()
    .select()
    .from(clusterImageCopies)
    .where(
      inArray(
        clusterImageCopies.appId,
        mine.map((a) => a.id),
      ),
    )
    .orderBy(
      desc(clusterImageCopies.createdAt),
      desc(clusterImageCopies.imageRef),
    );
  const out: Latest[] = [];
  for (const a of mine) {
    const newest = rows.find((r) => r.appId === a.id);
    if (!newest) continue;
    const holders = rows.filter(
      (r) =>
        r.appId === a.id &&
        r.imageRef === newest.imageRef &&
        r.state === "held",
    );
    // The server that runs it now is the natural source; any holder will do.
    const held = holders.find((r) => r.serverId === a.serverId) ?? holders[0];
    if (held)
      out.push({
        appId: a.id,
        clusterId: a.clusterId!,
        ref: newest.imageRef,
        source: held.serverId,
      });
  }
  return out;
}

async function progressOf(l: Latest) {
  const all = await members(l.clusterId);
  const arch = all.find((m) => m.serverId === l.source)?.arch ?? "";
  if (!arch) return { held: 0, total: 0 };
  const eligible = all.filter((m) => m.arch === arch).map((m) => m.serverId);
  const holding = new Set(await membersHoldingImage(l.appId, l.ref));
  return {
    held: eligible.filter((id) => holding.has(id)).length,
    total: eligible.length,
  };
}

/**
 * The active team's Apps on this cluster whose newest release has not reached every server of its architecture:
 * "web: on 2 of 3 servers". An App that is everywhere is not listed, so the line clears itself.
 */
export async function listClusterImageProgress(
  clusterId: string,
): Promise<ClusterImageProgress[]> {
  const teamId = await requireActiveTeamId();
  const out: ClusterImageProgress[] = [];
  const names = new Map(
    (
      await getDb()
        .select({ id: appsTable.id, name: appsTable.name })
        .from(appsTable)
        .where(
          and(eq(appsTable.clusterId, clusterId), eq(appsTable.teamId, teamId)),
        )
    ).map((a) => [a.id, a.name]),
  );
  for (const l of await latestReleases(clusterId, teamId)) {
    const p = await progressOf(l);
    if (p.held < p.total)
      out.push({ appId: l.appId, appName: names.get(l.appId) ?? "", ...p });
  }
  return out.sort((a, b) => a.appName.localeCompare(b.appName));
}

/** The sweep's job: a member that was offline, a failed copy or a server that joined later gets the image now. */
export async function reconcileClusterImages(): Promise<void> {
  for (const l of await latestReleases()) {
    if (await instanceFrozen()) return;
    const p = await progressOf(l);
    if (p.held < p.total) await copyReleaseToMembers(l.appId, l.ref, l.source);
  }
}
