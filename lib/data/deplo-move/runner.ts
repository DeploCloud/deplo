import "server-only";

import { and, asc, desc, eq, gt, inArray, isNotNull, ne } from "drizzle-orm";

import { caCertPem, signAgentCsr } from "../../agent/pki";
import { decryptSecretOrThrow } from "../../crypto";
import { getDb, type DbTx } from "../../db/client";
import {
  deploMoves,
  deploMoveServers,
} from "../../db/schema/control-plane/deplo-move";
import {
  serverTeams,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import * as moveClient from "../../deplo-move/client";
import type {
  MoveHello,
  MoveServerState,
  TargetMoveState,
} from "../../deplo-move/protocol";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import { nowIso } from "../../ids";
import { publicBaseUrl } from "../../public-url";
import { sourceAgentReachable } from "../agent-reach";
import { listAllServers } from "../servers/roster";
import { invalidateFrozen } from "./freeze";
import { restoreInstance } from "./restore";
import { recordForEveryTeam } from "./source-row";

// The new Deplo's half of a Deplo move (ADR-0035): copy, hand every server over, finish. Resumable from its row.
export type TargetMoveRow = typeof deploMoves.$inferSelect;
export type TargetMoveServerRow = typeof deploMoveServers.$inferSelect;

export const NO_PANEL_ADDRESS =
  "This Deplo has no address yet: set it under Settings, so the old Deplo can send people here.";
export const UNREACHABLE_NOTE =
  "This server answers to this Deplo now, but this machine cannot reach it yet.";
export const LEFT_BEHIND_NOTE =
  "Still answers to the old Deplo. Add it again under Settings → Servers.";

// What the public status says instead of an error it must not repeat.
export const COPY_FAILED =
  "The copy failed on this Deplo. Nothing was changed here.";
export const HANDOVER_FAILED =
  "This server could not be handed over because of an error on this Deplo.";
const STOPPED_HERE = "The move stopped because of an error on this Deplo.";

type Restorer = (
  lines: AsyncIterable<string>,
) => Promise<{ rows: number; unreadable: number }>;
let restorer: Restorer = (lines) => restoreInstance(lines);

export function __setRestorerForTest(fn?: Restorer): void {
  restorer = fn ?? ((lines) => restoreInstance(lines));
}

let afterMove: () => Promise<void> = runSkippedBootJobs;

export function __setAfterMoveForTest(fn?: () => Promise<void>): void {
  afterMove = fn ?? runSkippedBootJobs;
}

// One move per process. On globalThis: instrumentation and route handlers are separate bundles.
const RUN_KEY = Symbol.for("deplo.move.run");
type Run = { id: string; done: Promise<void> };
const slot = globalThis as unknown as { [RUN_KEY]?: Run };

export function activeMoveRun(): string | null {
  return slot[RUN_KEY]?.id ?? null;
}

export function launchMove(id: string): boolean {
  const current = slot[RUN_KEY];
  if (current) return current.id === id;
  const done: Promise<void> = run(id).finally(() => {
    if (slot[RUN_KEY]?.done === done) delete slot[RUN_KEY];
  });
  slot[RUN_KEY] = { id, done };
  return true;
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
        inArray(deploMoves.state, ["copying", "handing_over"]),
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
function sentenceOf(e: unknown, fallback: string): string {
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

async function run(id: string): Promise<void> {
  let fallback = COPY_FAILED;
  try {
    for (;;) {
      const row = await targetMoveRow(id);
      fallback = row?.state === "handing_over" ? STOPPED_HERE : COPY_FAILED;
      if (row?.state === "copying") await copyEverything(row);
      else if (row?.state === "handing_over") return await handOverAll(row);
      else return;
    }
  } catch (e) {
    const why = sentenceOf(e, fallback);
    console.error(`[deplo-move] the move ${id} stopped: ${why}`);
    await setMoveState(id, "failed", { error: why }).catch((err) =>
      console.error(
        `[deplo-move] could not record the failure: ${sentenceOf(err, STOPPED_HERE)}`,
      ),
    );
  }
}

async function copyEverything(row: TargetMoveRow): Promise<void> {
  const c = credentialOf(row);
  await moveClient.freeze(c);
  const hello = await moveClient.hello(c);
  const copied = await restorer(moveClient.dump(c));
  await recordForEveryTeam(
    `Moved this Deplo here from ${row.peerUrl}`,
    row.startedBy,
  );
  const order = await handOverOrder(hello);
  const self = await ownServerIds(hello);
  const now = nowIso();
  await getDb().transaction(async (tx) => {
    await mirrorOldPanelHost(tx, hello, self);
    await tx
      .delete(deploMoveServers)
      .where(eq(deploMoveServers.moveId, row.id));
    if (order.length)
      await tx.insert(deploMoveServers).values(
        order.map((s, position) => ({
          moveId: row.id,
          serverId: s.id,
          name: s.name,
          position,
          state: "waiting" satisfies MoveServerState,
          error: "",
          updatedAt: now,
        })),
      );
    await tx
      .update(deploMoves)
      .set({
        state: "handing_over" satisfies TargetMoveState,
        rowsCopied: copied.rows,
        unreadable: copied.unreadable,
        error: "",
        updatedAt: now,
      })
      .where(eq(deploMoves.id, row.id));
  });
  invalidateFrozen();
}

function oldPanelHostId(hello: MoveHello): string | null {
  return hello.servers.find((s) => s.isPanelHost)?.id ?? null;
}

async function ownServerIds(hello: MoveHello): Promise<string[]> {
  const self = deploHostSelfAddresses();
  const oldHost = oldPanelHostId(hello);
  return (await listAllServers())
    .filter((s) => s.id !== oldHost && isDeploHostServer(s, self))
    .map((s) => s.id);
}

// This machine takes the old panel machine's place, so it gets the same team access, never wider.
async function mirrorOldPanelHost(
  tx: DbTx,
  hello: MoveHello,
  ownIds: string[],
): Promise<void> {
  const oldHost = oldPanelHostId(hello);
  if (!oldHost || ownIds.length === 0) return;
  const [policy] = await tx
    .select({ allTeams: serversTable.allTeams })
    .from(serversTable)
    .where(eq(serversTable.id, oldHost))
    .limit(1);
  if (!policy) return;
  const grants = await tx
    .select({ teamId: serverTeams.teamId })
    .from(serverTeams)
    .where(eq(serverTeams.serverId, oldHost));
  await tx
    .update(serversTable)
    .set({ allTeams: policy.allTeams })
    .where(inArray(serversTable.id, ownIds));
  await tx.delete(serverTeams).where(inArray(serverTeams.serverId, ownIds));
  if (grants.length)
    await tx
      .insert(serverTeams)
      .values(
        ownIds.flatMap((serverId) =>
          grants.map((g) => ({ serverId, teamId: g.teamId })),
        ),
      );
}

// Every enrolled server the old Deplo listed, in its order, with the old panel's own machine last.
async function handOverOrder(
  hello: MoveHello,
): Promise<{ id: string; name: string }[]> {
  const enrolled = await getDb()
    .select({ id: serversTable.id, name: serversTable.name })
    .from(serversTable)
    .where(
      and(
        isNotNull(serversTable.agentCertFingerprint),
        ne(serversTable.agentCertFingerprint, ""),
      ),
    );
  const byId = new Map(enrolled.map((s) => [s.id, s]));
  const listed = hello.servers.filter((s) => byId.has(s.id));
  return [
    ...listed.filter((s) => !s.isPanelHost),
    ...listed.filter((s) => s.isPanelHost),
  ].map((s) => byId.get(s.id)!);
}

export async function markServer(
  moveId: string,
  serverId: string,
  state: MoveServerState,
  error: string,
): Promise<void> {
  await getDb()
    .update(deploMoveServers)
    .set({ state, error, updatedAt: nowIso() })
    .where(
      and(
        eq(deploMoveServers.moveId, moveId),
        eq(deploMoveServers.serverId, serverId),
      ),
    );
}

async function handOverAll(row: TargetMoveRow): Promise<void> {
  const c = credentialOf(row);
  for (const s of await moveServerRows(row.id)) {
    if (s.state === "handed_over") continue;
    let note: string;
    try {
      note = await handOver(c, s);
    } catch (e) {
      const why = sentenceOf(e, HANDOVER_FAILED);
      await markServer(row.id, s.serverId, "failed", why);
      throw new Error(`${s.name} was not handed over: ${why}`);
    }
    await markServer(row.id, s.serverId, "handed_over", note);
  }
  const movedTo = publicBaseUrl();
  if (!movedTo) throw new Error(NO_PANEL_ADDRESS);
  const handedOver = (await moveServerRows(row.id)).map((s) => s.serverId);
  await moveClient.finish(c, movedTo, handedOver);
  await setMoveState(row.id, "done", { error: "", finishedAt: nowIso() });
  startAfterMove();
}

function startAfterMove(): void {
  void afterMove().catch((e) =>
    console.error("[deplo-move] the jobs after the move failed:", e),
  );
}

export function leftBehindSentence(left: number): string {
  if (left === 0)
    return "Finished without the old Deplo: every server was handed over.";
  return `Finished without the old Deplo: ${left === 1 ? "1 server was" : `${left} servers were`} left behind.`;
}

// The old Deplo is gone: what was handed over stays here, every other server is named as left with it.
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
      .update(deploMoveServers)
      .set({
        state: "failed" satisfies MoveServerState,
        error: LEFT_BEHIND_NOTE,
        updatedAt: now,
      })
      .where(
        and(
          eq(deploMoveServers.moveId, id),
          ne(deploMoveServers.state, "handed_over"),
        ),
      )
      .returning({ serverId: deploMoveServers.serverId });
    await tx
      .update(deploMoves)
      .set({ error: leftBehindSentence(rows.length) })
      .where(eq(deploMoves.id, id));
    return { count: rows.length, peerUrl: claimed.peerUrl };
  });
  invalidateFrozen();
  if (!left) return false;
  const stay =
    left.count === 0
      ? "no server stays"
      : left.count === 1
        ? "1 server stays"
        : `${left.count} servers stay`;
  await recordForEveryTeam(
    `Finished moving this Deplo here without the old one at ${left.peerUrl ?? "its old address"}: ${stay} with it`,
    actor,
  );
  startAfterMove();
  return true;
}

// Signed with THIS Deplo's CA and installed with it: from the next handshake only this Deplo can dial the agent.
async function handOver(
  c: moveClient.MoveCredential,
  s: TargetMoveServerRow,
): Promise<string> {
  // A retry after an install whose answer was lost: the agent may already be ours.
  if (s.state === "failed" && (await sourceAgentReachable(s.serverId)))
    return "";
  const [server] = await getDb()
    .select({ ip: serversTable.ip, host: serversTable.host })
    .from(serversTable)
    .where(eq(serversTable.id, s.serverId))
    .limit(1);
  if (!server) throw new Error("This server is missing from the copy.");
  let csrPem: string;
  try {
    csrPem = await moveClient.csr(c, s.serverId);
  } catch (e) {
    if (e instanceof moveClient.MoveRefusedError && e.handedOver)
      return (await sourceAgentReachable(s.serverId)) ? "" : UNREACHABLE_NOTE;
    throw e;
  }
  const signed = await signAgentCsr(
    csrPem,
    [server.ip, server.host].filter(Boolean),
  );
  await getDb()
    .update(serversTable)
    .set({
      agentCertPem: signed.certPem,
      agentCertFingerprint: signed.fingerprint,
    })
    .where(eq(serversTable.id, s.serverId));
  await moveClient.install(c, s.serverId, signed.certPem, await caCertPem());
  return (await sourceAgentReachable(s.serverId)) ? "" : UNREACHABLE_NOTE;
}

// The boot one-shots a frozen Deplo skipped: they find the copied deployments, backups and deletes in flight.
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
      "network isolation sweep",
      async () =>
        (
          await import("../../deploy/network-migration")
        ).runNetworkIsolationSweep(),
    ],
    [
      "OAuth resources",
      async () =>
        (await import("../../auth/oauth-resources")).reconcileOAuthResources(),
    ],
  ];
  for (const [name, job] of jobs)
    await job().catch((e) =>
      console.error(`[deplo-move] ${name} after the move failed:`, e),
    );
}
