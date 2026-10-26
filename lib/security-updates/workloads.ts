import "server-only";

import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  max,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import { InventoryStatus, type WorkloadImage } from "../agent/gen/agent";
import { getDb } from "../db/client";
import { apps } from "../db/schema/control-plane/apps";
import { databases } from "../db/schema/control-plane/databases";
import { appPreviews } from "../db/schema/control-plane/deployments";
import {
  imageInventories,
  imageInventoryPackages,
  securityFindings,
  workloadImages,
} from "../db/schema/control-plane/security-updates";
import { connectAgent } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import {
  IMAGE_CANDIDATE_CAPABILITY,
  IMAGE_DEPS_CAPABILITY,
  IMAGE_INVENTORY_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import { builtByDeplo } from "./fix-kind";
import { registryState, repoDigestFor, repositoryOf } from "./registry-check";

// ponytail: a few images per server per tick; a large backfill takes a few ticks, raise if fleets grow.
export const INVENTORIES_PER_TICK = 3;
const RETRY_FAILED_MS = 24 * 60 * 60_000;

type WorkloadRow = typeof workloadImages.$inferInsert;

const STATUS_TEXT: Partial<Record<InventoryStatus, string>> = {
  [InventoryStatus.INVENTORY_STATUS_OK]: "ok",
  [InventoryStatus.INVENTORY_STATUS_SKIPPED_LOW_DISK]: "low_disk",
  [InventoryStatus.INVENTORY_STATUS_SKIPPED_LOW_MEMORY]: "low_memory",
  [InventoryStatus.INVENTORY_STATUS_TOO_LARGE]: "too_large",
  [InventoryStatus.INVENTORY_STATUS_TIMED_OUT]: "timed_out",
  [InventoryStatus.INVENTORY_STATUS_UNSUPPORTED]: "unsupported",
  [InventoryStatus.INVENTORY_STATUS_FAILED]: "failed",
};

// The team workload each container belongs to; a container Deplo cannot place is skipped.
async function resolveWorkloads(
  serverId: string,
  images: WorkloadImage[],
  now: string,
): Promise<WorkloadRow[]> {
  const ids = [...new Set(images.map((i) => i.projectId))];
  if (ids.length === 0) return [];
  const db = getDb();
  const [appRows, previewRows, dbRows] = await Promise.all([
    db
      .select({ id: apps.id, teamId: apps.teamId })
      .from(apps)
      .where(inArray(apps.id, ids)),
    db
      .select({
        id: appPreviews.id,
        appId: appPreviews.appId,
        teamId: apps.teamId,
      })
      .from(appPreviews)
      .innerJoin(apps, eq(apps.id, appPreviews.appId))
      .where(inArray(appPreviews.id, ids)),
    db
      .select({ id: databases.id, teamId: databases.teamId })
      .from(databases)
      .where(inArray(databases.id, ids)),
  ]);
  const owner = new Map<
    string,
    Pick<WorkloadRow, "kind" | "teamId" | "appId" | "previewId" | "databaseId">
  >();
  for (const a of appRows)
    owner.set(a.id, {
      kind: "app",
      teamId: a.teamId,
      appId: a.id,
      previewId: null,
      databaseId: null,
    });
  for (const p of previewRows)
    owner.set(p.id, {
      kind: "preview",
      teamId: p.teamId,
      appId: p.appId,
      previewId: p.id,
      databaseId: null,
    });
  for (const d of dbRows)
    owner.set(d.id, {
      kind: "database",
      teamId: d.teamId,
      appId: null,
      previewId: null,
      databaseId: d.id,
    });

  const rows = new Map<string, WorkloadRow>();
  for (const img of images) {
    const o = owner.get(img.projectId);
    if (!o) continue;
    const key = `${img.projectId}\0${img.service}`;
    const prev = rows.get(key);
    // A service scaled to several containers counts once; a running one wins.
    if (prev && (prev.running || !img.running)) continue;
    rows.set(key, {
      serverId,
      workloadId: img.projectId,
      service: img.service,
      ...o,
      imageRef: img.imageRef,
      imageId: img.imageId,
      repoDigest: repoDigestFor(img.imageRef, img.repoDigests),
      running: img.running,
      seenAt: now,
    });
  }
  return [...rows.values()];
}

async function upsertWorkloads(
  serverId: string,
  rows: WorkloadRow[],
  now: string,
) {
  const db = getDb();
  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(workloadImages)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            workloadImages.serverId,
            workloadImages.workloadId,
            workloadImages.service,
          ],
          set: {
            kind: sql`excluded.kind`,
            teamId: sql`excluded.team_id`,
            appId: sql`excluded.app_id`,
            previewId: sql`excluded.preview_id`,
            databaseId: sql`excluded.database_id`,
            running: sql`excluded.running`,
            repoDigest: sql`excluded.repo_digest`,
            seenAt: sql`excluded.seen_at`,
            checkedAt: sql`case when ${workloadImages.imageId} = excluded.image_id then ${workloadImages.checkedAt} else null end`,
            candidateRef: sql`case when ${workloadImages.imageId} = excluded.image_id then ${workloadImages.candidateRef} else null end`,
            candidateImageId: sql`case when ${workloadImages.imageId} = excluded.image_id then ${workloadImages.candidateImageId} else null end`,
            candidateStatus: sql`case when ${workloadImages.imageId} = excluded.image_id then ${workloadImages.candidateStatus} else null end`,
            candidateCheckedAt: sql`case when ${workloadImages.imageId} = excluded.image_id then ${workloadImages.candidateCheckedAt} else null end`,
            registryCheckedAt: sql`case when ${workloadImages.imageRef} = excluded.image_ref then ${workloadImages.registryCheckedAt} else null end`,
            imageRef: sql`excluded.image_ref`,
            imageId: sql`excluded.image_id`,
          },
        });
    }
    await tx
      .delete(workloadImages)
      .where(
        and(
          eq(workloadImages.serverId, serverId),
          ne(workloadImages.seenAt, now),
        ),
      );
  });
}

// Images on this server with no usable package list yet: never read, or a failure worth retrying.
async function imagesToInventory(
  serverId: string,
  now: Date,
  withDeps: boolean,
): Promise<string[]> {
  const retryBefore = new Date(now.getTime() - RETRY_FAILED_MS).toISOString();
  // Newest first: the image a deploy just started is the one someone is waiting on.
  const rows = await getDb()
    .select({ imageId: workloadImages.imageId })
    .from(workloadImages)
    .leftJoin(
      imageInventories,
      eq(imageInventories.imageId, workloadImages.imageId),
    )
    .where(
      and(
        eq(workloadImages.serverId, serverId),
        or(
          isNull(imageInventories.imageId),
          and(
            ne(imageInventories.status, "ok"),
            lt(imageInventories.scannedAt, retryBefore),
          ),
          // An app image read before the agent knew build-only packages is read once more.
          withDeps
            ? and(
                eq(imageInventories.status, "ok"),
                eq(imageInventories.depsRead, false),
                exists(
                  getDb()
                    .select({ one: sql`1` })
                    .from(imageInventoryPackages)
                    .where(
                      and(
                        eq(
                          imageInventoryPackages.imageId,
                          imageInventories.imageId,
                        ),
                        eq(imageInventoryPackages.type, "npm"),
                      ),
                    ),
                ),
              )
            : undefined,
        ),
      ),
    )
    .groupBy(workloadImages.imageId)
    .orderBy(desc(max(workloadImages.seenAt)))
    .limit(INVENTORIES_PER_TICK);
  return rows.map((r) => r.imageId);
}

async function storeInventory(
  imageId: string,
  resp: Awaited<ReturnType<AgentConnection["inventoryImage"]>>,
  now: string,
  depsRead: boolean,
): Promise<void> {
  const status = STATUS_TEXT[resp.status] ?? "failed";
  const pkgs = new Map<string, typeof imageInventoryPackages.$inferInsert>();
  for (const p of status === "ok" ? resp.packages : []) {
    pkgs.set(`${p.purl}\0${p.location}`, {
      imageId,
      purl: p.purl,
      location: p.location,
      type: p.type,
      name: p.name,
      version: p.version,
      buildOnly: p.buildOnly ?? false,
      via: (p.via ?? []).join("\t"),
    });
  }
  await getDb().transaction(async (tx) => {
    await tx
      .delete(imageInventories)
      .where(eq(imageInventories.imageId, imageId));
    await tx.insert(imageInventories).values({
      imageId,
      status,
      error: resp.error.slice(0, 500),
      distroId: resp.distroId,
      distroVersion: resp.distroVersion,
      workingDir: resp.workingDir,
      scannerVersion: resp.scannerVersion,
      scannedAt: now,
      depsRead,
    });
    const rows = [...pkgs.values()];
    for (let i = 0; i < rows.length; i += 500)
      await tx.insert(imageInventoryPackages).values(rows.slice(i, i + 500));
    // A package list read again is matched again on this tick's pass.
    await tx
      .update(workloadImages)
      .set({ checkedAt: null })
      .where(eq(workloadImages.imageId, imageId));
  });
}

export interface ServerRefresh {
  // False when the server could not be asked: its rows are left as they were.
  reached: boolean;
  inventoried: number;
}

// Refresh what runs on one server and read the packages of up to INVENTORIES_PER_TICK new images.
export async function refreshServer(
  serverId: string,
  now: Date,
  keepGoing: () => Promise<boolean> = async () => true,
): Promise<ServerRefresh> {
  let conn: AgentConnection;
  try {
    conn = await connectAgent(serverId);
  } catch {
    return { reached: false, inventoried: 0 };
  }
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(IMAGE_INVENTORY_CAPABILITY))
      return { reached: false, inventoried: 0 };
    const { images } = await conn.listWorkloadImages();
    const stamp = now.toISOString();
    await upsertWorkloads(
      serverId,
      await resolveWorkloads(serverId, images, stamp),
      stamp,
    );

    const withDeps = hello.capabilities.includes(IMAGE_DEPS_CAPABILITY);
    let inventoried = 0;
    for (const imageId of await imagesToInventory(serverId, now, withDeps)) {
      if (!(await keepGoing())) break;
      const resp = await conn.inventoryImage(imageId);
      if (resp.status === InventoryStatus.INVENTORY_STATUS_BUSY) break;
      await storeInventory(imageId, resp, new Date().toISOString(), withDeps);
      inventoried++;
    }
    if (
      hello.capabilities.includes(IMAGE_CANDIDATE_CAPABILITY) &&
      (await keepGoing())
    )
      await readOneCandidate(serverId, conn, now, withDeps);
    return { reached: true, inventoried };
  } catch (e) {
    console.warn(
      `[security-updates] ${serverId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { reached: false, inventoried: 0 };
  } finally {
    conn.close();
  }
}

// The newer build Update would bring: the same tag's newer digest, else the newer tag's.
export function candidateTarget(
  w: Pick<
    typeof workloadImages.$inferSelect,
    | "imageRef"
    | "repoDigest"
    | "registryStatus"
    | "registryDigest"
    | "newerTagDigest"
  >,
): string | null {
  if (builtByDeplo(w.imageRef) || w.registryStatus !== "ok") return null;
  const repo = repositoryOf(w.imageRef);
  if (w.registryDigest && w.repoDigest && w.registryDigest !== w.repoDigest)
    return `${repo}@${w.registryDigest}`;
  return w.newerTagDigest ? `${repo}@${w.newerTagDigest}` : null;
}

// ponytail: one pull per server per tick, the first that needs one; a queue if images pile up.
async function readOneCandidate(
  serverId: string,
  conn: AgentConnection,
  now: Date,
  withDeps: boolean,
): Promise<void> {
  const db = getDb();
  const retryBefore = now.getTime() - RETRY_FAILED_MS;
  const rows = await db
    .select()
    .from(workloadImages)
    .where(
      and(
        eq(workloadImages.serverId, serverId),
        eq(workloadImages.running, true),
        inArray(workloadImages.kind, ["app", "database"]),
        exists(
          db
            .select({ one: sql`1` })
            .from(securityFindings)
            .where(
              and(
                eq(securityFindings.serverId, workloadImages.serverId),
                eq(securityFindings.workloadId, workloadImages.workloadId),
                eq(securityFindings.service, workloadImages.service),
              ),
            ),
        ),
      ),
    );
  const due = rows.find((w) => {
    const target = candidateTarget(w);
    if (!target) return false;
    if (w.candidateRef !== target) return true;
    // A failed read is tried again a day later; a finished one is kept until the target moves.
    return (
      w.candidateStatus !== "ok" &&
      w.candidateStatus !== "busy" &&
      (!w.candidateCheckedAt ||
        new Date(w.candidateCheckedAt).getTime() < retryBefore)
    );
  });
  if (!due) return;
  const target = candidateTarget(due)!;
  const resp = await conn.inventoryCandidate(target, due.imageId);
  const result = resp.result;
  if (!result || result.status === InventoryStatus.INVENTORY_STATUS_BUSY)
    return;
  const stamp = new Date().toISOString();
  const ok =
    result.status === InventoryStatus.INVENTORY_STATUS_OK && !!resp.imageId;
  if (ok) await storeInventory(resp.imageId, result, stamp, withDeps);
  await db
    .update(workloadImages)
    .set({
      candidateRef: target,
      candidateImageId: ok ? resp.imageId : null,
      candidateStatus: STATUS_TEXT[result.status] ?? "failed",
      candidateCheckedAt: stamp,
      // Matched again on this tick's pass, now that the newer build's packages are known.
      checkedAt: null,
    })
    .where(
      and(
        eq(workloadImages.serverId, due.serverId),
        eq(workloadImages.workloadId, due.workloadId),
        eq(workloadImages.service, due.service),
      ),
    );
}

// ponytail: a week of grace for an image no workload uses any more; tune if storage matters.
export async function dropUnusedInventories(now: Date): Promise<void> {
  const before = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  await getDb()
    .delete(imageInventories)
    .where(
      and(
        lt(imageInventories.scannedAt, before),
        notExists(
          getDb()
            .select({ one: sql`1` })
            .from(workloadImages)
            .where(
              or(
                eq(workloadImages.imageId, imageInventories.imageId),
                eq(workloadImages.candidateImageId, imageInventories.imageId),
              ),
            ),
        ),
      ),
    );
}

const REGISTRY_EVERY_MS = 6 * 60 * 60_000;

// Ask each vendor image's registry for its current digest and a newer tag, at most every 6 hours.
export async function refreshRegistryStates(now: Date): Promise<void> {
  const before = new Date(now.getTime() - REGISTRY_EVERY_MS).toISOString();
  const db = getDb();
  const refs = await db
    .selectDistinct({ imageRef: workloadImages.imageRef })
    .from(workloadImages)
    .where(
      and(
        sql`${workloadImages.imageRef} not like 'deplo/%'`,
        or(
          isNull(workloadImages.registryCheckedAt),
          lt(workloadImages.registryCheckedAt, before),
        ),
      ),
    );
  const stamp = now.toISOString();
  for (const { imageRef } of refs) {
    const state = await registryState(imageRef).catch(() => ({
      status: "unknown" as const,
    }));
    const set =
      state.status === "ok"
        ? {
            registryStatus: "ok",
            registryDigest: state.digest,
            newerTag: state.newerTag,
            newerTagDigest: state.newerTagDigest,
          }
        : state.status === "private"
          ? {
              registryStatus: "private",
              registryDigest: null,
              newerTag: null,
              newerTagDigest: null,
            }
          : {};
    await db
      .update(workloadImages)
      .set({ ...set, registryCheckedAt: stamp })
      .where(eq(workloadImages.imageRef, imageRef));
  }
}
