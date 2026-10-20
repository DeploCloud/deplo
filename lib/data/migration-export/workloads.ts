import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  backupDestination as destTable,
  backupRuns as runsTable,
  backups as backupsTable,
} from "../../db/schema/control-plane/backups";
import { cronJobs as cronTable } from "../../db/schema/control-plane/crons";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  appBasicAuthUsers as basicAuthTable,
  domains as domainsTable,
} from "../../db/schema/control-plane/domains";
import { appPreviewEnvVars as previewVarsTable } from "../../db/schema/control-plane/env-vars";
import { tryDecryptSecret } from "../../crypto";
import { parseConnectionPassword } from "../../deploy/database-compose";
import type {
  DeploExportApp,
  DeploExportBackup,
  DeploExportBackupRun,
  DeploExportCron,
  DeploExportData,
  DeploExportDatabase,
  DeploExportDomain,
  DeploExportPreview,
} from "../../migration/deplo/export-shape";
import { loadAppsByTeam, loadEnvVarsForApps } from "../app-graph-load";
import { assembleDatabase } from "../backup-rows";
import { mountsByDatabase } from "../databases/rows";
import { landedFor } from "../migration-data/landed-targets";
import { appCapabilitiesForTeam } from "../node-access";

function opened(enc: string): string | null {
  const res = tryDecryptSecret(enc);
  return res.ok ? res.value : null;
}

function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}

async function dataOf(
  teamId: string,
  targetKind: "app" | "database",
  targetId: string,
): Promise<DeploExportData> {
  const landed = await landedFor(teamId, { targetKind, targetId });
  return {
    volumes: landed?.volumes ?? [],
    hostMounts: landed?.hostMounts ?? [],
  };
}

async function schedulesFor(teamId: string) {
  const db = getDb();
  const [crons, backups, runs, destinations] = await Promise.all([
    db.select().from(cronTable).where(eq(cronTable.teamId, teamId)),
    db.select().from(backupsTable).where(eq(backupsTable.teamId, teamId)),
    db
      .select()
      .from(runsTable)
      .where(and(eq(runsTable.teamId, teamId), eq(runsTable.status, "success")))
      .orderBy(runsTable.seq),
    db
      .select({ id: destTable.id, name: destTable.name })
      .from(destTable)
      .where(eq(destTable.teamId, teamId)),
  ]);
  const destName = new Map(destinations.map((d) => [d.id, d.name]));
  const cron = (r: (typeof crons)[number]): DeploExportCron => ({
    name: r.name,
    schedule: r.schedule,
    command: r.command,
    service: r.service,
    enabled: r.enabled,
  });
  const backup = (r: (typeof backups)[number]): DeploExportBackup => ({
    schedule: r.schedule,
    enabled: r.enabled,
    retentionCount: r.retentionCount,
    destination: destName.get(r.destinationId) ?? null,
    timezone: r.timezone,
  });
  const runsBy = groupBy(runs, (r) => r.appId ?? r.databaseId);
  const restorePoints = (id: string): DeploExportBackupRun[] =>
    (runsBy.get(id) ?? []).flatMap((r) => {
      const destination = destName.get(r.destinationId);
      if (!destination || !r.objectKey) return [];
      return [
        {
          destination,
          objectKey: r.objectKey,
          sizeBytes: r.sizeBytes,
          decryptedSizeBytes: r.decryptedSizeBytes,
          sha256: r.sha256,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
        },
      ];
    });
  return {
    appCrons: groupBy(crons, (r) => r.appId),
    dbCrons: groupBy(crons, (r) => r.databaseId),
    appBackups: groupBy(backups, (r) => r.appId),
    dbBackups: groupBy(backups, (r) => r.databaseId),
    cron,
    backup,
    restorePoints,
  };
}

// A private folder hides its apps from a team-wide member too, so the export reads what the caller can reveal.
export async function exportApps(
  teamId: string,
): Promise<{ apps: DeploExportApp[]; withheld: number }> {
  const db = getDb();
  const all = (await loadAppsByTeam(teamId)).filter((a) => !a.deletingAt);
  const reach = await appCapabilitiesForTeam(
    teamId,
    all.map((a) => ({
      id: a.id,
      folderId: a.folderId ?? null,
      projectId: a.projectId ?? null,
      environmentId: a.environmentId ?? null,
    })),
  );
  const apps = all.filter((a) => reach.get(a.id)?.includes("reveal_secrets"));
  const withheld = all.length - apps.length;
  const ids = apps.map((a) => a.id);
  if (ids.length === 0) return { apps: [], withheld };
  const [vars, domains, basicAuth, schedules, previews, previewVars] =
    await Promise.all([
      loadEnvVarsForApps(ids),
      db.select().from(domainsTable).where(inArray(domainsTable.appId, ids)),
      db
        .select()
        .from(basicAuthTable)
        .where(inArray(basicAuthTable.appId, ids)),
      schedulesFor(teamId),
      db
        .select({
          appId: appsTable.id,
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
        .where(inArray(appsTable.id, ids)),
      db
        .select()
        .from(previewVarsTable)
        .where(inArray(previewVarsTable.appId, ids))
        .orderBy(asc(previewVarsTable.key)),
    ]);
  const previewBy = new Map(
    previews.map(({ appId, ...p }): [string, DeploExportPreview] => [appId, p]),
  );
  const previewVarsBy = groupBy(previewVars, (v) => v.appId);
  const varsBy = groupBy(vars, (v) => v.appId);
  const domainsBy = groupBy(domains, (d) => d.appId);
  const authBy = groupBy(basicAuth, (b) => b.appId);

  const out: DeploExportApp[] = [];
  for (const a of apps) {
    const notes: string[] = [];
    const env = (varsBy.get(a.id) ?? []).flatMap((v) => {
      const value = opened(v.valueEnc);
      if (value === null) {
        notes.push(
          `${v.key} could not be decrypted on {panel}, so it did not come across. Set it under Variables.`,
        );
        return [];
      }
      return [
        {
          key: v.key,
          value,
          secret: v.type === "secret",
          targets: v.targets,
        },
      ];
    });
    const auth = (authBy.get(a.id) ?? []).flatMap((b) => {
      const password = opened(b.passwordEnc);
      if (password === null) {
        notes.push(
          `The basic-auth password of ${b.username} could not be decrypted on {panel}. Add that user again under Access.`,
        );
        return [];
      }
      return [{ username: b.username, password }];
    });
    const previewEnv = (previewVarsBy.get(a.id) ?? []).flatMap((v) => {
      const value = opened(v.valueEnc);
      if (value === null) {
        notes.push(
          `The preview override ${v.key} could not be decrypted on {panel}, so it did not come across. Set it under Previews.`,
        );
        return [];
      }
      return [{ key: v.key, value, secret: v.type === "secret" }];
    });
    out.push({
      id: a.id,
      name: a.name,
      slug: a.slug,
      projectId: a.projectId ?? null,
      environmentId: a.environmentId ?? null,
      folderId: a.folderId ?? null,
      serverId: a.serverId,
      status: a.status,
      source: a.source,
      repo: a.repo,
      dockerImage: a.dockerImage,
      compose: a.compose,
      files: a.mounts ?? [],
      volumes: a.volumes ?? [],
      ports: a.ports ?? [],
      build: a.build,
      autoDeploy: a.autoDeploy,
      previewEnabled: a.previewEnabled,
      resources: a.resources,
      healthCheck: a.healthCheck,
      logo: a.logo,
      env,
      domains: (domainsBy.get(a.id) ?? []).map((d): DeploExportDomain => ({
        host: d.name,
        port: d.port,
        pathPrefix: d.pathPrefix ?? "",
        stripPrefix: d.stripPrefix ?? false,
        service: d.service,
        https: d.entrypoint !== "web",
        certProvider: d.certProvider,
        primary: d.isPrimary,
        redirectTo: d.redirectTo,
        generated: d.source === "auto",
      })),
      basicAuth: auth,
      crons: (schedules.appCrons.get(a.id) ?? []).map(schedules.cron),
      backups: (schedules.appBackups.get(a.id) ?? []).map(schedules.backup),
      backupRuns: schedules.restorePoints(a.id),
      data: await dataOf(teamId, "app", a.id),
      notes,
      upload:
        a.source === "upload" && a.upload
          ? {
              filename: a.upload.filename,
              size: a.upload.size,
              uploadedAt: a.upload.uploadedAt,
            }
          : null,
      preview: previewBy.get(a.id),
      previewEnv,
    });
  }
  return { apps: out, withheld };
}

export async function exportDatabases(
  teamId: string,
): Promise<DeploExportDatabase[]> {
  const rows = await getDb()
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.teamId, teamId));
  if (rows.length === 0) return [];
  const [mounts, schedules] = await Promise.all([
    mountsByDatabase(rows.map((r) => r.id)),
    schedulesFor(teamId),
  ]);
  const out: DeploExportDatabase[] = [];
  for (const row of rows) {
    const d = assembleDatabase(row, mounts.get(row.id) ?? []);
    const conn = opened(d.connectionStringEnc);
    out.push({
      id: d.id,
      name: d.name,
      type: d.type,
      version: d.version,
      host: d.host,
      username: d.username,
      dbName: d.dbName,
      password: conn ? parseConnectionPassword(conn) : "",
      environmentId: d.environmentId,
      serverId: d.serverId,
      status: d.status,
      exposedPort: d.exposedPublicly ? d.exposedPort : null,
      customImage: d.customImage,
      customCommand: d.customCommand,
      resources: d.resources,
      mounts: d.mounts,
      crons: (schedules.dbCrons.get(d.id) ?? []).map(schedules.cron),
      backups: (schedules.dbBackups.get(d.id) ?? []).map(schedules.backup),
      backupRuns: schedules.restorePoints(d.id),
      data: await dataOf(teamId, "database", d.id),
      notes: conn
        ? []
        : [
            "Its password could not be decrypted on {panel}, so the database here has a new one. Update every app that connects to it.",
          ],
    });
  }
  return out;
}
