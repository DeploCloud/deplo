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

// One source database becomes one Deplo Database.
export async function importDatabaseService(
  c: SourceCredential,
  svc: SourceService,
  row: SourceDatabase,
  name: string,
  opts: {
    serverId: string | undefined;
    // The Environment its apps landed in - and therefore the network it has to answer
    // on, or `db-<slug>` does not resolve from them (ADR-0028).
    environmentId: string | null;
    // Undefined keeps the source's port, null publishes none, a number overrides.
    exposedPort?: number | null;
    mayExposePorts: boolean;
    sourceIsTargetHost: boolean;
    // The project it came from, which names a namesake database apart.
    projectName?: string;
    // Filled in with `old host -> new host`, for the apps that name it.
    dbHosts: Map<string, string>;
    // The panel's backup stores by name (lower-cased), as Deplo destinations.
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

  // A database's name is one per team here, and "postgres" is in every project
  // over there. The SAME environment is the same database (a second run, which
  // is how newer data comes across); anywhere else it is a namesake, and it
  // gets a name of its own rather than a skip that never copies its data.
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

  // The password is carried over on purpose (see mapDatabase), and as a GENERATED
  // credential: another platform's random token is not something a person chose, so
  // Deplo's account policy does not apply to it.
  const base = {
    name: spec.name,
    type: spec.type,
    version: spec.version,
    serverId,
    environmentId: opts.environmentId,
    username: spec.username ?? undefined,
    dbName: spec.dbName ?? undefined,
    // The source's image, pinned at CREATE so the first provision already runs it.
    customImage: spec.customImage,
  };
  const withPassword = {
    ...base,
    password: spec.password ?? undefined,
    passwordIsGenerated: true,
  };

  // What this database publishes here. The review may have said otherwise - a
  // different port, or none at all - and without the grant nothing can be
  // published whatever anyone chose.
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

  // The FIRST failure is the one worth reporting: every later attempt is Deplo
  // giving something up, so their errors describe the compromise, not the cause.
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

  // The port is held by the very container we are importing.
  if (!created && publishPort != null && opts.sourceIsTargetHost) {
    try {
      await sourceClient(c).stopService(svc.kind, svc.id);
      // Written down like the data phase's own stops: backing out starts again
      // exactly what Deplo stopped, and this one used to be forgotten.
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
    } catch {
      /* Dokploy would not stop it; the data phase tries again and says so. */
    }
  }

  // Two things can still fail here, and the report must name the one that did: the
  // port is held by something that is not ours, or the password cannot ride inside a
  // connection string.
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

  // The start command and the resource caps, both of which Deplo stores on a database
  // and neither of which the import was writing: a Postgres tuned with `-c
  // shared_buffers=1GB` arrived untuned, and one capped at 1 GB / 0.5 CPU arrived
  // uncapped - free to take the whole host from every other tenant.
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

  // The engine's config files. AFTER the create, because they are a whole-set replace
  // on an existing database - and before the report, so a refusal is one of the notes
  // rather than a silent gap.
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

  // Said out loud, because every connection string the import just brought over
  // still spells out the old one.
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

  // Says what happens NEXT, in this same import. "Restore your data" read as "go
  // find a dump and do it yourself", which is how someone concludes the import left
  // them with an empty database and no way to move the old one.
  notes.push(
    `Empty until the data copy runs, a moment from now in this same import. It answers as "${created.host}", not "${row.appName}", so update the connection strings.`,
  );
  // Both names an app can reach it by: the container's label (Dokploy) and the
  // service's own id, which is what Coolify hands out as the internal URL.
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
