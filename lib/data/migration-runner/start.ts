import "server-only";

import { and, eq } from "drizzle-orm";

import { encryptSecret } from "../../crypto";
import { getDb } from "../../db/client";
import {
  migrationRuns as runsTable,
  migrationRunServers as runServersTable,
  migrationRunTargets as targetsTable,
} from "../../db/schema/control-plane/migration";
import { publishMigrationChanged } from "../../graphql/pubsub";
import { newId, nowIso } from "../../ids";
import { holdsTeamWideCapability } from "../../membership";
import { sourceClient } from "../../migration/source";
import type {
  MigrationPlatform,
  SourceCredential,
} from "../../migration/source";
import { normalizeSourceBaseUrl } from "../../migration/transport";
import { assertMigrationMachinesReady } from "../migration-data/source-cutover";
import {
  assertImportGate,
  credentialFor as connectCredential,
} from "../migration-import/gates";
import { beginMigration } from "../migration-import/run-lifecycle";
import { createTeam } from "../teams";
import { runMigrationTick } from "./run-loop";

export interface StartRunInput {
  url: string;
  apiKey: string;
  kind?: MigrationPlatform;
  orgName?: string | null;
  targets: {
    projectId: string;
    projectName: string;
    serviceId: string;
    serverId?: string | null;
    buildServerId?: string | null;
    exposedPort?: number | null;
    exposedPortSet?: boolean;
  }[];
  servers: { from: string; to: string }[];
  keepSources?: boolean;
  queued?: QueuedTeamInput[];
}

export interface QueuedTeamInput {
  apiKey: string;
  orgName?: string | null;
  teamId?: string | null;
  newTeamName?: string | null;
  newTeamImage?: string | null;
  targets: StartRunInput["targets"];
  servers: { from: string; to: string }[];
}

export async function startMigrationRun(input: StartRunInput): Promise<string> {
  const { teamId } = await assertImportGate();
  if (input.targets.length === 0)
    throw new Error("Nothing is selected, so there is nothing to migrate.");

  const c = await connectCredential(input);
  const client = sourceClient(c);
  await client.assertReadable();
  await client.listProjects();
  await assertMigrationMachinesReady(
    c,
    input.targets.map((t) => t.serviceId),
  );

  const queued = input.queued ?? [];
  const queuedCreds: SourceCredential[] = [];
  for (const q of queued) {
    const qc = await connectCredential({
      url: input.url,
      apiKey: q.apiKey,
      kind: c.kind,
    });
    const qclient = sourceClient(qc);
    await qclient.assertReadable();
    await qclient.listProjects();
    queuedCreds.push(qc);
    if (q.targets.length === 0)
      throw new Error("A queued team has nothing selected to migrate.");
  }

  const runId = await beginMigration({
    url: input.url,
    orgName: input.orgName ?? null,
    kind: c.kind,
    keepSources: queued.length > 0 || (input.keepSources ?? false),
  });
  const { currentIdentity } = await import("../../auth/request-context");
  const { getCurrentUser } = await import("../../auth/current-user");
  const me = await getCurrentUser();
  const userId = currentIdentity()?.userId ?? me?.id ?? null;
  const actorName = me?.name ?? "someone";

  await getDb().transaction(async (tx) => {
    await tx
      .update(runsTable)
      .set({
        apiKeyEnc: encryptSecret(input.apiKey),
        actorUserId: userId,
        totalSteps: input.targets.length,
        doneSteps: 0,
        phase: "config",
        stopRequested: false,
        stepLabel: input.targets[0]?.projectName ?? null,
      })
      .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
    for (const t of input.targets)
      await tx.insert(targetsTable).values({
        id: newId("dtgt"),
        runId,
        projectId: t.projectId,
        projectName: t.projectName,
        serviceId: t.serviceId,
        serverId: t.serverId ?? null,
        buildServerId: t.buildServerId ?? null,
        exposedPort: t.exposedPort ?? null,
        exposedPortSet: t.exposedPortSet ?? false,
      });
    for (const s of input.servers)
      if (s.to)
        await tx
          .insert(runServersTable)
          .values({ runId, fromId: s.from, toId: s.to })
          .onConflictDoNothing();
  });

  for (const [i, q] of queued.entries())
    await enqueueTeam({
      sessionId: runId,
      url: input.url,
      credential: queuedCreds[i],
      team: q,
      actor: { name: actorName, userId },
      keepSources: i < queued.length - 1,
    });

  publishMigrationChanged();
  void runMigrationTick().catch((e) =>
    console.error("[migration] first tick failed:", e),
  );
  return runId;
}

async function enqueueTeam(opts: {
  sessionId: string;
  url: string;
  credential: SourceCredential;
  team: QueuedTeamInput;
  actor: { name: string; userId: string | null };
  keepSources: boolean;
}): Promise<string> {
  const { team } = opts;
  let teamId = team.teamId?.trim() || "";
  if (teamId) {
    if (!(await holdsTeamWideCapability(teamId, "create_projects")))
      throw new Error("You cannot create projects in one of the teams chosen.");
  } else {
    const name = team.newTeamName?.trim() || team.orgName?.trim() || "";
    if (!name) throw new Error("A queued team needs a name to land under.");
    teamId = (await createTeam({ name, image: team.newTeamImage ?? null })).id;
  }
  const id = newId("dimp");
  const now = nowIso();
  await getDb().transaction(async (tx) => {
    await tx.insert(runsTable).values({
      id,
      teamId,
      sourceUrl: normalizeSourceBaseUrl(opts.url),
      platform: opts.credential.kind,
      orgName: team.orgName?.trim() || null,
      actor: opts.actor.name,
      actorUserId: opts.actor.userId,
      status: "queued",
      created: 0,
      skipped: 0,
      failed: 0,
      manual: 0,
      error: null,
      startedAt: now,
      finishedAt: null,
      apiKeyEnc: encryptSecret(team.apiKey),
      totalSteps: team.targets.length,
      doneSteps: 0,
      phase: "config",
      keepSources: opts.keepSources,
      sessionId: opts.sessionId,
    });
    for (const t of team.targets)
      await tx.insert(targetsTable).values({
        id: newId("dtgt"),
        runId: id,
        projectId: t.projectId,
        projectName: t.projectName,
        serviceId: t.serviceId,
        serverId: t.serverId ?? null,
        buildServerId: t.buildServerId ?? null,
        exposedPort: t.exposedPort ?? null,
        exposedPortSet: t.exposedPortSet ?? false,
      });
    for (const s of team.servers)
      if (s.to)
        await tx
          .insert(runServersTable)
          .values({ runId: id, fromId: s.from, toId: s.to })
          .onConflictDoNothing();
  });
  return id;
}
