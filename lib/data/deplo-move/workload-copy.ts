import "server-only";

import { setTimeout as sleep } from "node:timers/promises";

import { and, eq, inArray, ne } from "drizzle-orm";

import { encryptSecret } from "../../crypto";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { deploMoveWorkloads } from "../../db/schema/control-plane/deplo-move";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import * as moveClient from "../../deplo-move/client";
import type { MoveWorkloadInfo, WorkloadRef } from "../../deplo-move/protocol";
import { startDeployment } from "../../deploy/build/deploy-start";
import { buildConnectionString } from "../../deploy/database-compose";
import { explainNetworkError } from "../../deploy/network";
import { archiveExt, restoreUpload } from "../../deploy/upload";
import {
  publishAppChanged,
  publishDatabaseChanged,
} from "../../graphql/pubsub";
import { newId, nowIso } from "../../ids";
import { connectAgent } from "../../infra/agent-client/connect";
import type { Database } from "../../types/database";
import { assembleDatabase } from "../backup-rows";
import { mountsFor } from "../databases/rows";
import {
  databasePassword,
  renderDatabaseStackYaml,
  rerouteRequest,
} from "../databases/stack";
import { withKeyedLock } from "../keyed-mutex";
import { startAndVerifyDatabase } from "../migration-data/database-verify";
import { dropTeardown } from "../teardown-queue";
import {
  copyFilesBetween,
  copyHostPathBetween,
  copyVolumeBetween,
  startStackOn,
  stopStackOn,
} from "../volume-migration";
import type { MoveClaims } from "./workload-claims";

// One workload of a Deplo move (ADR-0035): deploy it here, then fill it from the old Deplo while it is paused there.
export interface CopyOptions {
  creator: string;
  signal: AbortSignal;
  claims: MoveClaims;
}

let starter: typeof startDeployment = startDeployment;

export function __setDeployStarterForTest(fn?: typeof startDeployment): void {
  starter = fn ?? startDeployment;
}

const DEPLOY_WAIT_MS = 2 * 60 * 60_000;
const DEPLOY_POLL_MS = 2_000;

const LAPSED =
  "The old Deplo started it again before its data finished copying. Try again.";

// Resolves to a note for its row (what was not copied), empty when everything came across.
export async function copyWorkload(
  c: moveClient.MoveCredential,
  ref: WorkloadRef,
  opts: CopyOptions,
): Promise<string> {
  const info = await moveClient.workload(c, ref, opts.signal);
  opts.claims.remember(info);
  if (ref.kind === "database") await copyDatabase(c, ref, info, opts);
  else await copyApp(c, ref, info, opts);
  return notCopiedNote(info);
}

function notCopiedNote(info: MoveWorkloadInfo): string {
  const left = info.skippedHostPaths ?? [];
  if (left.length === 0) return "";
  const named =
    left.length > 5
      ? `${left.slice(0, 5).join(", ")} and ${left.length - 5} more`
      : left.join(", ");
  return `Not copied, as they are the old server's own folders: ${named}.`;
}

function hasData(info: MoveWorkloadInfo): boolean {
  return info.volumes.length > 0 || info.hostPaths.length > 0 || info.files;
}

// A refusal means it no longer holds the pause (code dead, cancelled there, lease lapsed); a network error proves nothing.
async function letGoReason(
  c: moveClient.MoveCredential,
  ref: WorkloadRef,
): Promise<string | null> {
  try {
    return (await moveClient.resume(c, ref)) ? null : LAPSED;
  } catch (e) {
    if (
      e instanceof moveClient.MoveRefusedError &&
      (e.status === 401 || e.status === 409)
    )
      return e.message || LAPSED;
    console.warn(
      `[deplo-move] the old Deplo did not take back ${ref.kind} ${ref.id}; its lease will: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

// Stopped there only while its bytes cross; the lease starts it again even if this Deplo dies mid-copy.
async function whilePaused(
  c: moveClient.MoveCredential,
  ref: WorkloadRef,
  opts: CopyOptions,
  copy: () => Promise<void>,
): Promise<boolean> {
  const paused = await moveClient.pause(c, ref, opts.signal);
  let copied = false;
  let letGo: string | null = null;
  try {
    await copy();
    copied = true;
  } finally {
    letGo = await letGoReason(c, ref);
  }
  if (copied && letGo) throw new Error(letGo);
  return paused.wasRunning;
}

async function copyData(
  c: moveClient.MoveCredential,
  ref: WorkloadRef,
  info: MoveWorkloadInfo,
  where: { serverId: string; slug: string },
  signal: AbortSignal,
): Promise<void> {
  const source = {
    exportVolume: (name: string) => moveClient.volume(c, ref, name, signal),
    exportHostPath: (path: string, allowFile?: boolean) =>
      moveClient.hostPath(c, ref, path, allowFile === true, signal),
    exportFiles: () => moveClient.files(c, ref, signal),
  };
  const dest = await connectAgent(where.serverId);
  try {
    for (const v of info.volumes) {
      const res = await copyVolumeBetween(
        source,
        dest,
        v,
        v,
        undefined,
        signal,
      );
      if (res.missing)
        throw new Error(
          `The volume ${v} is not on the old server, so it could not be copied.`,
        );
    }
    if (info.files) await copyFilesBetween(source, dest, where.slug);
    for (const h of info.hostPaths) {
      const res = await copyHostPathBetween(
        source,
        dest,
        h.path,
        h.path,
        undefined,
        signal,
      );
      if (res.missing)
        throw new Error(
          `The folder ${h.path} is not on the old server, so it could not be copied.`,
        );
    }
  } finally {
    dest.close();
  }
}

async function loadDatabaseRow(id: string): Promise<Database | null> {
  const [row] = await getDb()
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, id))
    .limit(1);
  return row ? assembleDatabase(row, await mountsFor(row.id)) : null;
}

async function setDatabaseStatus(id: string, status: string): Promise<void> {
  await getDb()
    .update(databasesTable)
    .set({ status })
    .where(eq(databasesTable.id, id));
  publishDatabaseChanged(id);
}

// A published database is reached at its server's address, which is this side's now (as a server move does it).
async function connectionHere(db: Database, password: string): Promise<string> {
  const exposed = db.exposedPublicly && db.exposedPort != null;
  const [server] = exposed
    ? await getDb()
        .select({ host: serversTable.host })
        .from(serversTable)
        .where(eq(serversTable.id, db.serverId))
        .limit(1)
    : [];
  return encryptSecret(
    buildConnectionString({
      type: db.type,
      username: db.username,
      password,
      host: exposed && server ? server.host : db.host,
      port: exposed ? db.exposedPort! : db.port,
      dbName: db.dbName,
    }),
  );
}

// Through the agent with no signed-in user: the move itself is the actor.
async function provisionDatabase(db: Database): Promise<void> {
  const password = databasePassword(db);
  const yaml = renderDatabaseStackYaml(db, password);
  // A teardown queued by an earlier, cancelled move would otherwise remove this one later.
  await dropTeardown(db.serverId, db.host);
  const conn = await connectAgent(db.serverId);
  try {
    const res = await conn.reroute(rerouteRequest(db, yaml));
    if (!res.ok)
      throw new Error(
        explainNetworkError(
          res.error || `The server here could not set up ${db.name}.`,
        ),
      );
  } finally {
    conn.close();
  }
  await getDb()
    .update(databasesTable)
    .set({ connectionStringEnc: await connectionHere(db, password) })
    .where(eq(databasesTable.id, db.id));
  await setDatabaseStatus(db.id, "running");
}

async function copyDatabase(
  c: moveClient.MoveCredential,
  ref: WorkloadRef,
  info: MoveWorkloadInfo,
  opts: CopyOptions,
): Promise<void> {
  const db = await loadDatabaseRow(ref.id);
  if (!db) throw new Error("This database is missing from the copy.");
  await opts.claims.check(ref, info, {
    serverId: db.serverId,
    dbHost: db.host,
  });
  await withKeyedLock(db.id, async () => {
    await provisionDatabase(db);
    const where = { serverId: db.serverId, slug: db.host };
    let running = info.running;
    if (hasData(info)) {
      await stopStackOn(where.serverId, where.slug);
      running = await whilePaused(c, ref, opts, () =>
        copyData(c, ref, info, where, opts.signal),
      );
    } else if (!running) await stopStackOn(where.serverId, where.slug);
    if (!running) return setDatabaseStatus(db.id, "stopped");
    const verified = await startAndVerifyDatabase(
      {
        targetKind: "database",
        targetId: db.id,
        targetName: db.name,
        targetSlug: db.host,
        targetServerId: db.serverId,
        volumes: [],
        hostMounts: [],
        fileMounts: new Set(),
        engine: { type: db.type, username: db.username, dbName: db.dbName },
      },
      db.teamId,
      hasData(info),
    );
    if (!verified.ok) throw new Error(verified.message);
  });
}

async function loadAppRow(id: string) {
  const [row] = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      teamId: appsTable.teamId,
      serverId: appsTable.serverId,
      latestDeploymentId: appsTable.latestDeploymentId,
      uploadId: appsTable.uploadId,
      uploadFilename: appsTable.uploadFilename,
      uploadPath: appsTable.uploadPath,
    })
    .from(appsTable)
    .where(eq(appsTable.id, id))
    .limit(1);
  return row ?? null;
}

type AppRow = NonNullable<Awaited<ReturnType<typeof loadAppRow>>>;

// The archive goes back under the id the copied row names, so the app's source reads as it did there.
async function copyUpload(
  c: moveClient.MoveCredential,
  ref: WorkloadRef,
  app: AppRow,
  signal: AbortSignal,
): Promise<void> {
  const sent = await moveClient.upload(c, ref, signal);
  try {
    const name = app.uploadFilename || sent.filename;
    const ext = archiveExt(app.uploadPath ?? "") ?? archiveExt(name);
    if (!ext)
      throw new Error(`${app.name}'s archive is not a kind Deplo builds.`);
    const uploadId = app.uploadId || newId("upl");
    const stored = await restoreUpload({
      appId: app.id,
      uploadId,
      ext,
      body: sent.chunks,
    });
    await getDb()
      .update(appsTable)
      .set({
        uploadId,
        uploadFilename: name || `archive${ext}`,
        uploadPath: stored.path,
        uploadSize: stored.size,
        ...(app.uploadId ? {} : { uploadUploadedAt: nowIso() }),
      })
      .where(eq(appsTable.id, app.id));
  } finally {
    sent.close();
  }
}

async function importImage(
  c: moveClient.MoveCredential,
  ref: WorkloadRef,
  app: AppRow,
  imageRef: string,
  signal: AbortSignal,
): Promise<void> {
  const dest = await connectAgent(app.serverId);
  try {
    const res = await dest.importImage(
      imageRef,
      moveClient.image(c, ref, imageRef, signal),
    );
    if (!res.ok)
      throw new Error(
        res.error || `The server here could not load ${app.name}'s image.`,
      );
  } finally {
    dest.close();
  }
}

// The image it runs there, deployed like a rollback: no rebuild, so what runs here is exactly what ran there.
async function rollbackTo(
  app: AppRow,
  image: { ref: string; deploymentId: string },
  creator: string,
): Promise<string> {
  const [dep] = await getDb()
    .select()
    .from(deploymentsTable)
    .where(eq(deploymentsTable.id, image.deploymentId))
    .limit(1);
  return starter(app.id, {
    environment: "production",
    creator,
    rollback: {
      deploymentId: dep?.rollbackOf || image.deploymentId,
      imageRef: image.ref,
      commitSha: dep?.commitSha ?? "",
      commitMessage: dep?.commitMessage ?? "Deploy",
      commitAuthor: dep?.commitAuthor ?? creator,
      builtAt: dep?.readyAt ?? dep?.createdAt ?? nowIso(),
    },
  });
}

async function waitForDeployment(
  depId: string,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + DEPLOY_WAIT_MS;
  for (;;) {
    if (signal.aborted) {
      await getDb()
        .update(deploymentsTable)
        .set({ status: "canceled" })
        .where(
          and(
            eq(deploymentsTable.id, depId),
            inArray(deploymentsTable.status, ["queued", "building"]),
          ),
        );
      signal.throwIfAborted();
    }
    const [row] = await getDb()
      .select({ status: deploymentsTable.status })
      .from(deploymentsTable)
      .where(eq(deploymentsTable.id, depId))
      .limit(1);
    if (row?.status === "ready") return;
    if (!row || row.status === "canceled")
      throw new Error(`${name}'s deploy here was cancelled.`);
    if (row.status === "error")
      throw new Error(
        `${name} did not deploy here: open its deployments to see why.`,
      );
    if (Date.now() > deadline)
      throw new Error(`${name} was still deploying here after 2 hours.`);
    await sleep(DEPLOY_POLL_MS, undefined, { signal }).catch(() => {});
  }
}

async function setAppIdle(id: string): Promise<void> {
  await getDb()
    .update(appsTable)
    .set({ status: "idle", updatedAt: nowIso() })
    .where(eq(appsTable.id, id));
  publishAppChanged(id);
}

async function copyApp(
  c: moveClient.MoveCredential,
  ref: WorkloadRef,
  info: MoveWorkloadInfo,
  opts: CopyOptions,
): Promise<void> {
  const app = await loadAppRow(ref.id);
  if (!app) throw new Error("This app is missing from the copy.");
  await opts.claims.check(ref, info, { serverId: app.serverId });
  if (info.upload) await copyUpload(c, ref, app, opts.signal);
  // Never deployed there: nothing to run or fill here either.
  if (!info.image && !app.latestDeploymentId && !info.running) return;
  await dropTeardown(app.serverId, app.slug);
  let depId: string;
  if (info.image) {
    await importImage(c, ref, app, info.image.ref, opts.signal);
    depId = await rollbackTo(app, info.image, opts.creator);
  } else
    depId = await starter(app.id, {
      environment: "production",
      creator: opts.creator,
    });
  await waitForDeployment(depId, app.name, opts.signal);

  const where = { serverId: app.serverId, slug: app.slug };
  let running = info.running;
  if (hasData(info)) {
    await stopStackOn(where.serverId, where.slug);
    running = await whilePaused(c, ref, opts, () =>
      copyData(c, ref, info, where, opts.signal),
    );
    if (running) await startStackOn(where.serverId, where.slug);
  } else if (!running) await stopStackOn(where.serverId, where.slug);
  if (!running) await setAppIdle(app.id);
}

// Left out by an admin: stopped here unless another workload of the move runs under the same name on that server.
// Resolves to the team it belongs to.
export async function leaveOutHere(
  moveId: string,
  ref: WorkloadRef,
): Promise<string | null> {
  if (ref.kind === "app") {
    const app = await loadAppRow(ref.id);
    if (!app) return null;
    await stopStackOn(app.serverId, app.slug).catch((e) =>
      console.warn(`[deplo-move] could not stop ${app.name} here:`, e),
    );
    await setAppIdle(app.id);
    return app.teamId;
  }
  const row = await loadDatabaseRow(ref.id);
  if (!row) return null;
  const shared = await getDb()
    .select({ id: databasesTable.id })
    .from(deploMoveWorkloads)
    .innerJoin(
      databasesTable,
      and(
        eq(deploMoveWorkloads.kind, "database"),
        eq(deploMoveWorkloads.workloadId, databasesTable.id),
      ),
    )
    .where(
      and(
        eq(deploMoveWorkloads.moveId, moveId),
        inArray(deploMoveWorkloads.state, ["copying", "done"]),
        eq(databasesTable.serverId, row.serverId),
        eq(databasesTable.host, row.host),
        ne(databasesTable.id, row.id),
      ),
    )
    .limit(1);
  if (shared.length === 0)
    await stopStackOn(row.serverId, row.host).catch((e) =>
      console.warn(`[deplo-move] could not stop ${row.name} here:`, e),
    );
  await setDatabaseStatus(row.id, "stopped");
  return row.teamId;
}
