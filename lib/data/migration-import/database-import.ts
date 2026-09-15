import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  migrationRunDbHosts as dbHostsTable,
  migrationRunTargets as targetsTable,
} from "../../db/schema/control-plane/migration";
import { nowIso } from "../../ids";
import { requireActiveTeamId } from "../../membership";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import type { SourceDbKind } from "../../migration/model";
import type { SourceDatabase } from "../../migration/model";
import { mapResources } from "../../migration/map/app-settings";
import { mapDatabase } from "../../migration/map/databases";
import { setDatabaseMounts } from "../databases/mounts";
import { createDatabase } from "../databases/provision";
import type { Report } from "./run-report";
import type { SourceService } from "./source-tree";
import { landSourceBackups } from "./source-backups";

export async function importDatabaseService(
  c: SourceCredential,
  svc: SourceService,
  row: SourceDatabase,
  name: string,
  opts: {
    serverId: string | undefined;
    environmentId: string | null;
    exposedPort?: number | null;
    mayExposePorts: boolean;
    sourceIsTargetHost: boolean;
    projectName?: string;
    dbHosts: Map<string, string>;
    destinations?: Map<string, string>;
  },
  report: Report,
): Promise<void> {
  const { serverId } = opts;
  const mapped = mapDatabase(svc.kind as SourceDbKind, { ...row, name });
  const notes = [...mapped.notes];
  if (!mapped.value) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "unsupported",
      targetKind: "database",
      message: notes.join(" ") || "Deplo has no such engine.",
    });
    return;
  }
  const spec = mapped.value;

  const teamId = await requireActiveTeamId();
  const taken = async (candidate: string) =>
    (
      await getDb()
        .select({
          id: databasesTable.id,
          environmentId: databasesTable.environmentId,
        })
        .from(databasesTable)
        .where(
          and(
            eq(databasesTable.teamId, teamId),
            sql`lower(${databasesTable.name}) = ${candidate.trim().toLowerCase()}`,
          ),
        )
    )[0];
  const clash = await taken(spec.name);
  if (clash && clash.environmentId === opts.environmentId) {
    const extra: string[] = [];
    await landSourceBackups(
      row.backups,
      opts.destinations,
      { kind: "database", id: clash.id, name: spec.name },
      extra,
    );
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "skipped",
      targetKind: "database",
      targetId: clash.id,
      message: [
        "A database with this name is already in this environment, so it is the one that is kept - its data is copied again in this same import.",
        ...extra,
      ].join(" "),
    });
    return;
  }
  if (clash) {
    const suffix =
      (opts.projectName ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "2";
    const base = `${spec.name.trim()}-${suffix}`;
    let candidate = base;
    for (let n = 2; await taken(candidate); n++) candidate = `${base}-${n}`;
    notes.push(
      `This team already has a database called ${spec.name}, so this one is ${candidate}.`,
    );
    spec.name = candidate;
  }

  const base = {
    name: spec.name,
    type: spec.type,
    version: spec.version,
    serverId,
    environmentId: opts.environmentId,
    username: spec.username ?? undefined,
    dbName: spec.dbName ?? undefined,
    customImage: spec.customImage,
  };
  const withPassword = {
    ...base,
    password: spec.password ?? undefined,
    // Another platform's random token is not a password a person chose, so the account policy stays off it.
    passwordIsGenerated: true,
  };

  const sourcePort = spec.exposedPort ?? null;
  const chosenPort =
    opts.exposedPort !== undefined ? opts.exposedPort : sourcePort;
  if (!opts.mayExposePorts && chosenPort != null)
    notes.push(
      `Port ${chosenPort} was not published: you don't have permission to publish ports.`,
    );
  else if (chosenPort == null && sourcePort != null)
    notes.push(
      `Port ${sourcePort} was not published, as chosen during the import.`,
    );
  const publishPort = opts.mayExposePorts ? chosenPort : null;
  const withPort =
    publishPort != null
      ? { exposedPublicly: true, exposedPort: publishPort }
      : {};

  const portNote = (why: string) =>
    `Port ${publishPort} was not published (${why}). Publish it from the database's Connection settings once that port is free.`;

  let firstError = "";
  const attempt = async (payload: Parameters<typeof createDatabase>[0]) => {
    try {
      return await createDatabase(payload);
    } catch (e) {
      if (!firstError) firstError = e instanceof Error ? e.message : "refused";
      return null;
    }
  };

  let created = await attempt({ ...withPassword, ...withPort });

  if (!created && publishPort != null && opts.sourceIsTargetHost) {
    try {
      await sourceClient(c).stopService(svc.kind, svc.id);
      if (report.id)
        await getDb()
          .update(targetsTable)
          .set({ stoppedKind: svc.kind, stoppedAt: nowIso() })
          .where(
            and(
              eq(targetsTable.runId, report.id),
              eq(targetsTable.serviceId, svc.id),
            ),
          );
      created = await attempt({ ...withPassword, ...withPort });
    } catch {}
  }

  if (!created && publishPort != null) {
    created = await attempt(withPassword);
    if (created) notes.push(portNote(firstError));
  }
  if (!created) {
    created = await attempt(base);
    if (created) {
      if (publishPort != null) notes.push(portNote(firstError));
      notes.push(
        `Password refused (${firstError}), so Deplo made a new one - the imported connection strings still hold the old.`,
      );
    }
  }
  if (!created) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "failed",
      targetKind: "database",
      message: firstError || "Could not create the database.",
    });
    return;
  }

  if (spec.command) {
    try {
      const { updateDatabaseImage } = await import("../databases/settings");
      await updateDatabaseImage(created.id, { customCommand: spec.command });
    } catch (e) {
      notes.push(
        `Its start command was not imported: ${e instanceof Error ? e.message : "refused"}. Set it under Settings -> Advanced.`,
      );
    }
  }
  const dbResources = mapResources(row);
  notes.push(...dbResources.notes);
  if (dbResources.value) {
    try {
      const { updateDatabaseResources } = await import("../databases/settings");
      await updateDatabaseResources(created.id, dbResources.value);
    } catch (e) {
      notes.push(
        `Its memory and CPU limits were not imported: ${e instanceof Error ? e.message : "refused"}. Set them under Settings -> Resources.`,
      );
    }
  }

  if (spec.mounts.length > 0) {
    try {
      await setDatabaseMounts(created.id, spec.mounts);
    } catch (e) {
      notes.push(
        `The engine's config files were not imported: ${
          e instanceof Error ? e.message : "refused"
        }. Add them under Settings -> Advanced.`,
      );
    }
  }

  await landSourceBackups(
    row.backups,
    opts.destinations,
    { kind: "database", id: created.id, name: spec.name },
    notes,
  );

  if (publishPort != null && sourcePort != null && publishPort !== sourcePort)
    notes.push(
      `Published on ${publishPort} instead of ${sourcePort} - update the connection strings that name the old port.`,
    );

  await report.add({
    sourceKind: svc.kind,
    sourceId: svc.id,
    sourceName: name,
    outcome: "created",
    targetKind: "database",
    targetId: created.id,
  });

  notes.push(
    `Empty until the data copy runs, a moment from now in this same import. It answers as "${created.host}", not "${row.appName}", so update the connection strings.`,
  );
  for (const from of [row.appName, svc.id])
    if (from?.trim()) {
      opts.dbHosts.set(from.trim(), created.host);
      if (report.id)
        await getDb()
          .insert(dbHostsTable)
          .values({
            runId: report.id,
            sourceHost: from.trim(),
            targetHost: created.host,
            environmentId: opts.environmentId,
          })
          .onConflictDoUpdate({
            target: [dbHostsTable.runId, dbHostsTable.sourceHost],
            set: {
              targetHost: created.host,
              environmentId: opts.environmentId,
            },
          });
    }
  await report.notes(
    svc.kind,
    name,
    notes,
    { kind: "database", id: created.id },
    svc.id,
  );
}
