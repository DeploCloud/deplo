import "server-only";

import { and, asc, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";

import { decryptSecretOrThrow } from "../../crypto";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { migrationRuns } from "../../db/schema/control-plane/migration";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import {
  deploMoves,
  deploMoveServers,
  deploMoveWorkloads,
} from "../../db/schema/control-plane/deplo-move";
import * as moveClient from "../../deplo-move/client";
import type {
  MoveWorkloadState,
  TargetMoveState,
  WorkloadKind,
} from "../../deplo-move/protocol";
import { nowIso } from "../../ids";
import { invalidateFrozen } from "./freeze";
import { restoreInstance, type RestoreOptions } from "./restore";
import { invalidateSchedulesPaused } from "./schedules";
import { recordForEveryTeam } from "./source-row";
import { MoveClaims } from "./workload-claims";
import { copyWorkload } from "./workload-copy";

// The new Deplo's half of a Deplo move (ADR-0035): copy the database, then deploy and fill every workload here.
export type TargetMoveRow = typeof deploMoves.$inferSelect;
export type TargetMoveServerRow = typeof deploMoveServers.$inferSelect;
export type TargetMoveWorkloadRow = typeof deploMoveWorkloads.$inferSelect;

export const NO_PANEL_ADDRESS =
  "This Deplo has no address yet: set it under Settings, so the old Deplo can send people here.";

// What the public status says instead of an error it must not repeat.
export const COPY_FAILED =
  "The copy failed on this Deplo. Nothing was changed here.";
export const WORKLOAD_FAILED =
  "This could not be copied because of an error on this Deplo.";
export const SKIPPED_NOTE =
  "Its data never came across: restore it from a backup.";
export const MIGRATION_STOPPED_NOTE =
  "Stopped by the Deplo move: the old Deplo still runs it.";
const STOPPED_HERE = "The move stopped because of an error on this Deplo.";
const STOPPED = "The move was stopped.";

type Restorer = (
  lines: AsyncIterable<string>,
  opts: RestoreOptions,
) => Promise<{ rows: number; unreadable: number }>;
let restorer: Restorer = restoreInstance;

export function __setRestorerForTest(fn?: Restorer): void {
  restorer = fn ?? restoreInstance;
}

let afterCopy: () => Promise<void> = runSkippedBootJobs;

export function __setAfterMoveForTest(fn?: () => Promise<void>): void {
  afterCopy = fn ?? runSkippedBootJobs;
}

// One move per process. On globalThis: instrumentation and route handlers are separate bundles.
const RUN_KEY = Symbol.for("deplo.move.run");
type Run = { id: string; done: Promise<void>; aborter: AbortController };
const slot = globalThis as unknown as { [RUN_KEY]?: Run };

export function activeMoveRun(): string | null {
  return slot[RUN_KEY]?.id ?? null;
}

export function launchMove(id: string): boolean {
  const current = slot[RUN_KEY];
  if (current) return current.id === id;
  const aborter = new AbortController();
  const done: Promise<void> = run(id, aborter.signal).finally(() => {
    if (slot[RUN_KEY]?.done === done) delete slot[RUN_KEY];
  });
  slot[RUN_KEY] = { id, done, aborter };
  return true;
}

// Stops the run between steps and cuts any stream in flight; resolves once it has let go.
export async function stopMoveRun(id: string): Promise<void> {
  const current = slot[RUN_KEY];
  if (!current || current.id !== id) return;
  current.aborter.abort();
  await current.done;
}

export function __waitForMoveForTest(): Promise<void> {
  return slot[RUN_KEY]?.done ?? Promise.resolve();
}

export async function resumeDeploMoves(): Promise<void> {
  const [row] = await getDb()
    .select({ id: deploMoves.id })
    .from(deploMoves)
    .where(
      and(
        eq(deploMoves.side, "target"),
        inArray(deploMoves.state, ["copying", "deploying"]),
      ),
    )
    .orderBy(desc(deploMoves.updatedAt))
    .limit(1);
  if (!row) return;
  console.log(`[deplo-move] resuming the move ${row.id}`);
  launchMove(row.id);
}

export function credentialOf(row: TargetMoveRow): moveClient.MoveCredential {
  if (!row.peerUrl || !row.codeEnc)
    throw new Error("This move lost its connection to the old Deplo.");
  return {
    baseUrl: row.peerUrl,
    code: decryptSecretOrThrow(row.codeEnc, "The move code"),
  };
}

export async function targetMoveRow(id: string): Promise<TargetMoveRow | null> {
  const [row] = await getDb()
    .select()
    .from(deploMoves)
    .where(and(eq(deploMoves.id, id), eq(deploMoves.side, "target")))
    .limit(1);
  return row ?? null;
}

export async function moveServerRows(
  moveId: string,
): Promise<TargetMoveServerRow[]> {
  return getDb()
    .select()
    .from(deploMoveServers)
    .where(eq(deploMoveServers.moveId, moveId))
    .orderBy(asc(deploMoveServers.position));
}

export async function moveWorkloadRows(
  moveId: string,
): Promise<TargetMoveWorkloadRow[]> {
  return getDb()
    .select()
    .from(deploMoveWorkloads)
    .where(eq(deploMoveWorkloads.moveId, moveId))
    .orderBy(asc(deploMoveWorkloads.position));
}

export async function setMoveState(
  id: string,
  state: TargetMoveState,
  extra: Partial<Omit<TargetMoveRow, "id" | "side" | "state">> = {},
): Promise<void> {
  await getDb()
    .update(deploMoves)
    .set({ ...extra, state, updatedAt: nowIso() })
    .where(and(eq(deploMoves.id, id), eq(deploMoves.side, "target")));
  invalidateFrozen();
}

export async function markWorkload(
  moveId: string,
  w: Pick<TargetMoveWorkloadRow, "kind" | "workloadId">,
  state: MoveWorkloadState,
  error = "",
): Promise<void> {
  await getDb()
    .update(deploMoveWorkloads)
    .set({ state, error, updatedAt: nowIso() })
    .where(
      and(
        eq(deploMoveWorkloads.moveId, moveId),
        eq(deploMoveWorkloads.kind, w.kind),
        eq(deploMoveWorkloads.workloadId, w.workloadId),
      ),
    );
}

type ErrorLink = Record<string, unknown>;

function causeChain(e: unknown): ErrorLink[] {
  const out: ErrorLink[] = [];
  let x = e;
  while (x && typeof x === "object" && out.length < 5) {
    out.push(x as ErrorLink);
    x = (x as ErrorLink).cause;
  }
  return out;
}

// A query error carries every bound value (whole rows, in a copy), and Postgres' own may quote one.
function fromTheDatabase(o: ErrorLink): boolean {
  const msg = typeof o.message === "string" ? o.message : "";
  return (
    "query" in o ||
    "params" in o ||
    (typeof o.severity === "string" && typeof o.code === "string") ||
    msg.startsWith("Failed query") ||
    msg.includes("params:")
  );
}

// Only sentences this code wrote reach the row; a database error is logged by its code and names alone.
export function sentenceOf(e: unknown, fallback: string): string {
  const chain = causeChain(e);
  if (chain.some(fromTheDatabase)) {
    const pg = chain.find((o) => typeof o.code === "string") ?? {};
    const said = (["code", "table", "constraint"] as const)
      .filter((k) => typeof pg[k] === "string" && pg[k])
      .map((k) => `${k} ${String(pg[k])}`);
    console.error(
      `[deplo-move] a database error${said.length ? ` (${said.join(", ")})` : ""}: ${fallback}`,
    );
    return fallback;
  }
  if (!(e instanceof Error)) return fallback;
  return e.message.trim() || "The move stopped without saying why.";
}

async function run(id: string, signal: AbortSignal): Promise<void> {
  let fallback = COPY_FAILED;
  try {
    for (;;) {
      signal.throwIfAborted();
      const row = await targetMoveRow(id);
      fallback = row?.state === "deploying" ? STOPPED_HERE : COPY_FAILED;
      if (row?.state === "copying") await copyEverything(row, signal);
      else if (row?.state === "deploying") return await deployAll(row, signal);
      else return;
    }
  } catch (e) {
    const why = signal.aborted ? STOPPED : sentenceOf(e, fallback);
    console.error(`[deplo-move] the move ${id} stopped: ${why}`);
    await setMoveState(id, "failed", { error: why }).catch((err) =>
      console.error(
        `[deplo-move] could not record the failure: ${sentenceOf(err, STOPPED_HERE)}`,
      ),
    );
  }
}

// Frozen from here until the copy commits: the only phase where this Deplo pauses changes.
async function copyEverything(
  row: TargetMoveRow,
  signal: AbortSignal,
): Promise<void> {
  const c = credentialOf(row);
  const servers = await moveServerRows(row.id);
  const serverMap = new Map(
    servers.map((s) => [s.serverId, s.targetServerId] as const),
  );
  const hello = await moveClient.hello(c, signal);
  if (row.peerInstance && hello.instance !== row.peerInstance)
    throw new Error(
      "Another Deplo answers at the old address now: cancel this move and start a new one.",
    );
  const copied = await restorer(moveClient.dump(c, signal), {
    serverMap,
    peerUrl: row.peerUrl ?? "",
  });
  const workloads = await workloadsToCopy();
  const now = nowIso();
  await getDb().transaction(async (tx) => {
    await tx
      .delete(deploMoveWorkloads)
      .where(eq(deploMoveWorkloads.moveId, row.id));
    if (workloads.length)
      await tx.insert(deploMoveWorkloads).values(
        workloads.map((w, position) => ({
          moveId: row.id,
          kind: w.kind,
          workloadId: w.id,
          name: w.name,
          position,
          state: "waiting" satisfies MoveWorkloadState,
          error: "",
          updatedAt: now,
        })),
      );
    // A deploy the old Deplo had in flight belongs to its servers; the move deploys each app here itself.
    await tx
      .update(deploymentsTable)
      .set({ status: "canceled" })
      .where(inArray(deploymentsTable.status, ["queued", "building"]));
    // Its migrations too: driven from here as well, every import would run twice.
    await tx
      .update(migrationRuns)
      .set({
        status: "stopped",
        error: MIGRATION_STOPPED_NOTE,
        finishedAt: now,
        phase: "done",
        apiKeyEnc: null,
        runnerOwner: null,
      })
      .where(inArray(migrationRuns.status, ["queued", "running"]));
    for (const table of [
      appsTable,
      databasesTable,
      projectsTable,
      environmentsTable,
    ])
      await tx
        .update(table)
        .set({ migrationRunId: null })
        .where(isNotNull(table.migrationRunId));
    await tx
      .update(deploMoves)
      .set({
        state: "deploying" satisfies TargetMoveState,
        rowsCopied: copied.rows,
        unreadable: copied.unreadable,
        schedulesPaused: true,
        error: "",
        updatedAt: now,
      })
      .where(eq(deploMoves.id, row.id));
  });
  invalidateFrozen();
  invalidateSchedulesPaused();
  await recordForEveryTeam(
    `Copied this Deplo here from ${row.peerUrl}`,
    row.startedBy,
  ).catch((e) =>
    console.error(
      `[deplo-move] could not record the copy: ${sentenceOf(e, STOPPED_HERE)}`,
    ),
  );
  await afterCopy().catch((e) =>
    console.error("[deplo-move] the jobs after the copy failed:", e),
  );
}

// Databases first, so an app that starts here finds its database already filled.
async function workloadsToCopy(): Promise<
  { kind: WorkloadKind; id: string; name: string }[]
> {
  const db = getDb();
  const [dbs, apps] = await Promise.all([
    db
      .select({ id: databasesTable.id, name: databasesTable.name })
      .from(databasesTable)
      .orderBy(asc(databasesTable.createdAt), asc(databasesTable.id)),
    db
      .select({ id: appsTable.id, name: appsTable.name })
      .from(appsTable)
      .orderBy(asc(appsTable.createdAt), asc(appsTable.id)),
  ]);
  return [
    ...dbs.map((d) => ({ kind: "database" as const, ...d })),
    ...apps.map((a) => ({ kind: "app" as const, ...a })),
  ];
}

const OPEN_WORKLOADS: MoveWorkloadState[] = ["waiting", "copying", "failed"];

// One workload at a time; a failure is recorded on its row and the rest still go.
async function deployAll(
  row: TargetMoveRow,
  signal: AbortSignal,
): Promise<void> {
  const c = credentialOf(row);
  const claims = new MoveClaims(row.id, c, signal);
  for (const w of await moveWorkloadRows(row.id)) {
    if (!OPEN_WORKLOADS.includes(w.state as MoveWorkloadState)) continue;
    signal.throwIfAborted();
    await markWorkload(row.id, w, "copying");
    let note: string;
    try {
      note = await copyWorkload(
        c,
        { kind: w.kind as WorkloadKind, id: w.workloadId },
        { creator: row.startedBy, signal, claims },
      );
    } catch (e) {
      signal.throwIfAborted();
      const why = sentenceOf(e, WORKLOAD_FAILED);
      console.error(`[deplo-move] ${w.name} was not copied: ${why}`);
      await markWorkload(row.id, w, "failed", why);
      continue;
    }
    await markWorkload(row.id, w, "done", note);
  }
  // Read back, not counted: an admin may have left a failed one out meanwhile.
  const failed = (await moveWorkloadRows(row.id)).filter(
    (w) => w.state === "failed",
  ).length;
  if (failed > 0)
    throw new Error(
      failed === 1
        ? "1 app or database could not be copied: see why below, then try again."
        : `${failed} apps or databases could not be copied: see why below, then try again.`,
    );
  await moveClient.finish(c);
  await setMoveState(row.id, "done", { error: "", finishedAt: nowIso() });
}

export function skippedSentence(left: number): string {
  if (left === 0)
    return "Finished without the old Deplo: everything came across.";
  return `Finished without the old Deplo: ${left === 1 ? "1 app or database was" : `${left} apps or databases were`} left out.`;
}

// The old Deplo is gone: whatever did not come across is left out here, never deployed empty.
export async function finishWithoutOldDeplo(
  id: string,
  actor: string,
): Promise<boolean> {
  const now = nowIso();
  const left = await getDb().transaction(async (tx) => {
    const [claimed] = await tx
      .update(deploMoves)
      .set({
        state: "done" satisfies TargetMoveState,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(deploMoves.id, id),
          eq(deploMoves.side, "target"),
          eq(deploMoves.state, "failed"),
          gt(deploMoves.rowsCopied, 0),
        ),
      )
      .returning({ peerUrl: deploMoves.peerUrl });
    if (!claimed) return null;
    const rows = await tx
      .update(deploMoveWorkloads)
      .set({
        state: "skipped" satisfies MoveWorkloadState,
        error: SKIPPED_NOTE,
        updatedAt: now,
      })
      .where(
        and(
          eq(deploMoveWorkloads.moveId, id),
          inArray(deploMoveWorkloads.state, OPEN_WORKLOADS),
        ),
      )
      .returning({ id: deploMoveWorkloads.workloadId });
    await tx
      .update(deploMoves)
      .set({ error: skippedSentence(rows.length) })
      .where(eq(deploMoves.id, id));
    return { count: rows.length, peerUrl: claimed.peerUrl };
  });
  invalidateFrozen();
  if (!left) return false;
  await recordForEveryTeam(
    `Finished copying this Deplo here without the old one at ${left.peerUrl ?? "its old address"}: ${
      left.count === 1
        ? "1 app or database was left out"
        : `${left.count} apps or databases were left out`
    }`,
    actor,
  );
  return true;
}

// The boot one-shots a frozen Deplo skipped: they find the copied backups, cleanups and deletes in flight.
async function runSkippedBootJobs(): Promise<void> {
  const jobs: [string, () => Promise<unknown>][] = [
    [
      "deployment reconcile",
      async () => {
        const { reconcileInFlightDeployments } =
          await import("../../deploy/build/deployment-state");
        const { startDeployQueue } = await import("../../deploy/deploy-queue");
        await reconcileInFlightDeployments();
        await startDeployQueue();
      },
    ],
    [
      "backup reconcile",
      async () =>
        (await import("../backups/orphan-sweep")).reconcileInFlightBackupRuns(),
    ],
    [
      "cleanup reconcile",
      async () =>
        (
          await import("../docker-cleanup/run-history")
        ).reconcileInFlightCleanupRuns(),
    ],
    [
      "app deletes",
      async () => (await import("../apps/delete")).resumeAppDeletes(),
    ],
    [
      "OAuth resources",
      async () =>
        (await import("../../auth/oauth-resources")).reconcileOAuthResources(),
    ],
  ];
  for (const [name, job] of jobs)
    await job().catch((e) =>
      console.error(`[deplo-move] ${name} after the copy failed:`, e),
    );
}
