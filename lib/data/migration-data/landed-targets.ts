import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  appVolumes as appVolumesTable,
  apps as appsTable,
} from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { DB_DATA_DIRS } from "../../deploy/database-compose";
import { stackFilesDir } from "../../deploy/deploy-key";
import type { DatabaseType } from "../../types/database";

import {
  composeHostMounts,
  composeVolumeMounts,
  normalizePath,
  deploDatabaseVolumeName,
  deploVolumeName,
} from "../../migration/map/volume-discovery";
import type { HostMount, NamedVolume } from "../../migration/model";

export interface Landed {
  targetKind: "app" | "database";
  targetId: string;
  targetName: string;
  /** The stack slug the agent knows it by. */
  targetSlug: string;
  targetServerId: string;
  volumes: NamedVolume[];
  /** The host directories this app bind-mounts. Only an app has any. */
  hostMounts: HostMount[];
  /** Container paths a config file already fills - its bytes came across with the
   *  configuration, so no host directory has to. */
  fileMounts: Set<string>;
  /** Engine facts, for the post-copy check. Only on a database. */
  engine?: { type: DatabaseType; username: string; dbName: string };
}

/**
 * What this import run landed on: source service id → the Deplo resource. A
 * service the run SKIPPED because it was already here is a target too - read as
 * "not created", a second pass copied nothing and took the agent off the source.
 */
export async function runTargets(
  runId: string,
): Promise<Map<string, { targetKind: "app" | "database"; targetId: string }>> {
  const rows = await getDb()
    .select({
      sourceId: itemsTable.sourceId,
      targetKind: itemsTable.targetKind,
      targetId: itemsTable.targetId,
      outcome: itemsTable.outcome,
    })
    .from(itemsTable)
    .where(eq(itemsTable.runId, runId));

  const out = new Map<
    string,
    { targetKind: "app" | "database"; targetId: string }
  >();
  // A skipped target counts only when a migration made it: somebody's own app
  // or database is never a place a copy may wipe and refill. The durable fact is
  // a `created` line in SOME run's report; the row's own marker is transient.
  const migrated = async (kind: "app" | "database", ids: string[]) => {
    if (ids.length === 0) return new Set<string>();
    const table = kind === "app" ? appsTable : databasesTable;
    const marked = await getDb()
      .select({ id: table.id })
      .from(table)
      .where(and(inArray(table.id, ids), isNotNull(table.migrationRunId)));
    const created = await getDb()
      .select({ id: itemsTable.targetId })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.targetKind, kind),
          inArray(itemsTable.targetId, ids),
          eq(itemsTable.outcome, "created"),
        ),
      );
    return new Set([
      ...marked.map((h) => h.id),
      ...created.map((h) => h.id).filter((id): id is string => id != null),
    ]);
  };
  const skippedApps = await migrated(
    "app",
    rows
      .filter(
        (r) => r.outcome === "skipped" && r.targetKind === "app" && r.targetId,
      )
      .map((r) => r.targetId!),
  );
  const skippedDbs = await migrated(
    "database",
    rows
      .filter(
        (r) =>
          r.outcome === "skipped" && r.targetKind === "database" && r.targetId,
      )
      .map((r) => r.targetId!),
  );
  for (const r of rows) {
    if (!r.sourceId || !r.targetId) continue;
    if (r.targetKind !== "app" && r.targetKind !== "database") continue;
    if (r.outcome === "skipped") {
      const ok = r.targetKind === "app" ? skippedApps : skippedDbs;
      if (!ok.has(r.targetId)) continue;
    } else if (r.outcome !== "created") continue;
    out.set(r.sourceId, { targetKind: r.targetKind, targetId: r.targetId });
  }
  return out;
}

/**
 * The imported resource itself, with the volumes it would receive. Loaded BY ID
 * and scoped to the team, so a run item pointing somewhere it should not reach
 * resolves to nothing rather than to someone else's database.
 */
export async function landedFor(
  teamId: string,
  target: { targetKind: "app" | "database"; targetId: string },
): Promise<Landed | null> {
  if (target.targetKind === "database") {
    const rows = await getDb()
      .select({
        id: databasesTable.id,
        name: databasesTable.name,
        host: databasesTable.host,
        type: databasesTable.type,
        username: databasesTable.username,
        dbName: databasesTable.dbName,
        serverId: databasesTable.serverId,
      })
      .from(databasesTable)
      .where(
        and(
          eq(databasesTable.id, target.targetId),
          eq(databasesTable.teamId, teamId),
        ),
      );
    const hit = rows[0];
    if (!hit) return null;
    return {
      targetKind: "database",
      targetId: hit.id,
      targetName: hit.name,
      targetSlug: hit.host,
      targetServerId: hit.serverId,
      volumes: [
        {
          name: deploDatabaseVolumeName(hit.host),
          mountPath: DB_DATA_DIRS[hit.type as DatabaseType] ?? "/data",
        },
      ],
      hostMounts: [],
      fileMounts: new Set(),
      engine: {
        type: hit.type as DatabaseType,
        username: hit.username,
        dbName: hit.dbName,
      },
    };
  }

  const rows = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      serverId: appsTable.serverId,
      compose: appsTable.compose,
    })
    .from(appsTable)
    .where(
      and(eq(appsTable.id, target.targetId), eq(appsTable.teamId, teamId)),
    );
  const hit = rows[0];
  if (!hit) return null;

  const managed = await getDb()
    .select({
      name: appVolumesTable.name,
      type: appVolumesTable.type,
      hostPath: appVolumesTable.hostPath,
      projectPath: appVolumesTable.projectPath,
      mountPath: appVolumesTable.mountPath,
    })
    .from(appVolumesTable)
    .where(eq(appVolumesTable.appId, hit.id));

  return {
    targetKind: "app",
    targetId: hit.id,
    targetName: hit.name,
    targetSlug: hit.slug,
    targetServerId: hit.serverId,
    volumes: [
      // A volume Deplo manages is rendered with an explicit `name:`; one declared
      // in the user's own compose is prefixed by the project, and `deploVolumeName`
      // is the only place that knows which is which.
      ...managed
        .filter((v) => (v.type ?? "named") === "named")
        .map((v) => ({
          name: deploVolumeName(hit.slug, v.name, true),
          mountPath: v.mountPath,
          alias: v.name,
        })),
      ...composeVolumeMounts(hit.compose ?? "").map((v) => ({
        name: deploVolumeName(hit.slug, v.name, false),
        mountPath: v.mountPath,
        alias: v.name,
      })),
    ],
    hostMounts: [
      ...managed
        .filter((v) => v.type === "host" && (v.hostPath ?? "").trim())
        .map((v) => ({ hostPath: v.hostPath!.trim(), mountPath: v.mountPath })),
      // The stack's own YAML binds host directories too, and it is the same file
      // that came across: a `./x` bind resolves into the stack's files dir,
      // exactly where the render points it (`rewriteMountSource`).
      ...composeHostMounts(hit.compose ?? "", stackFilesDir(hit.slug)),
      // A directory the panel kept beside the app lands in Deplo's own files dir,
      // and it is a directory: the config channel carries files, not folders.
      ...managed
        .filter((v) => v.type === "app" && (v.projectPath ?? "").trim())
        .map((v) => ({
          hostPath: `${stackFilesDir(hit.slug)}/${v.projectPath!.trim()}`,
          mountPath: v.mountPath,
          stackRelative: true,
        })),
    ],
    // A file mount lands as a project file, not a bind, and the panel handed over
    // its CONTENT with the configuration - so nothing here is missing it.
    fileMounts: new Set(
      managed
        .filter((v) => v.type === "app")
        .map((v) => normalizePath(v.mountPath)),
    ),
  };
}
