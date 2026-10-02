import "server-only";

import { X509Certificate } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { getDb, type DbTx, type DrizzleClient } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { backupRuns } from "../../db/schema/control-plane/backups";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  deploMoves,
  deploMoveServers,
} from "../../db/schema/control-plane/deplo-move";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { migrationRuns } from "../../db/schema/control-plane/migration";
import {
  teams as teamsTable,
  users as usersTable,
} from "../../db/schema/control-plane/identity";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { CERT_RENEWAL_CAPABILITY } from "../../agent/cert-renewal";
import { sha256Hex } from "../../crypto";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import {
  MOVE_CODE_PREFIX,
  MOVE_PROTOCOL,
  type MoveCsrResponse,
  type MoveFinishRequest,
  type MoveHello,
  type MoveInstallRequest,
  type MoveServerSummary,
  type SourceMoveState,
} from "../../deplo-move/protocol";
import { schemaTag } from "../../deplo-move/schema-tag";
import { connectAgent } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { HEALTH_HELLO_TIMEOUT_MS } from "../../infra/agent-client/deadlines";
import { unreachableMessage } from "../../infra/server-health";
import { nowIso } from "../../ids";
import { instanceFingerprint } from "../../migration/deplo/instance";
import { publicBaseUrl } from "../../public-url";
import type { Server } from "../../types/server";
import { DEPLO_VERSION } from "../../version";
import { listAllServers } from "../servers/roster";
import { FROZEN_CACHE_MS, instanceFrozen, invalidateFrozen } from "./freeze";
import {
  MoveRefusedError,
  RESUMED,
  enrolledServers,
  installsInFlight,
  probeAgent,
  recordForEveryTeam,
  thawSourceMove,
  type SourceMoveRow,
} from "./source-row";

export { MoveRefusedError };

// Who is calling: the move code plus the new Deplo's own name for itself (MOVE_PEER_HEADER / _URL_HEADER).
export interface MoveCaller {
  code: string;
  peerInstance: string;
  peerUrl: string;
}

function originOf(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

const INVALID_CODE =
  "This move code is not valid. Create a new one on the old Deplo.";

// The ONLY gate of every step: never a session, never an API token (ADR-0035).
export async function authenticateMoveCode(
  raw: string,
  peerInstance: string,
  peerUrl: string,
): Promise<SourceMoveRow> {
  const code = raw.trim();
  if (!code.startsWith(MOVE_CODE_PREFIX))
    throw new MoveRefusedError(INVALID_CODE, 401);
  const db = getDb();
  let [row] = await db
    .select()
    .from(deploMoves)
    .where(
      and(
        eq(deploMoves.side, "source"),
        eq(deploMoves.codeHash, sha256Hex(code)),
      ),
    )
    .limit(1);
  if (!row) throw new MoveRefusedError(INVALID_CODE, 401);

  const peer = peerInstance.trim();
  if (!peer)
    throw new MoveRefusedError("The new Deplo did not say who it is.", 400);
  if (peer === instanceFingerprint())
    throw new MoveRefusedError(
      "This move code belongs to this Deplo. Use it on the new one.",
      403,
    );

  if (row.state === "armed") {
    if (!row.expiresAt || Date.parse(row.expiresAt) <= Date.now())
      throw new MoveRefusedError(
        "This move code expired. Create a new one on the old Deplo.",
        401,
      );
    const [bound] = await db
      .update(deploMoves)
      .set({
        state: "bound",
        peerInstance: peer,
        // Only shown to people; the instance is what the code is bound to.
        peerUrl: originOf(peerUrl),
        updatedAt: nowIso(),
      })
      .where(and(eq(deploMoves.id, row.id), eq(deploMoves.state, "armed")))
      .returning();
    if (bound) return bound;
    [row] = await db
      .select()
      .from(deploMoves)
      .where(eq(deploMoves.id, row.id))
      .limit(1);
    if (!row) throw new MoveRefusedError(INVALID_CODE, 401);
  }
  if (row.peerInstance !== peer)
    throw new MoveRefusedError(
      "This move code is already in use by another Deplo.",
      403,
    );
  if (row.state === RESUMED)
    throw new MoveRefusedError(
      "The old Deplo was resumed without finishing this move. Start again with a new move code.",
      409,
    );
  return row;
}

function auth(caller: MoveCaller): Promise<SourceMoveRow> {
  return authenticateMoveCode(caller.code, caller.peerInstance, caller.peerUrl);
}

function requireFrozen(row: SourceMoveRow): void {
  if (row.state === "moved")
    throw new MoveRefusedError(
      `This Deplo already moved to ${row.peerUrl ?? "another machine"}.`,
      409,
    );
  if (row.state !== "frozen")
    throw new MoveRefusedError(
      "Changes on the old Deplo are not paused yet.",
      409,
    );
}

function peerOf(row: SourceMoveRow): string {
  return row.peerUrl ?? "another machine";
}

export async function moveHello(caller: MoveCaller): Promise<MoveHello> {
  const row = await auth(caller);
  const db = getDb();
  const [teams, users, apps, databases, servers] = await Promise.all([
    db.$count(teamsTable),
    db.$count(usersTable),
    db.$count(appsTable),
    db.$count(databasesTable),
    db.$count(serversTable),
  ]);
  return {
    protocol: MOVE_PROTOCOL,
    version: DEPLO_VERSION,
    schema: schemaTag(),
    instance: instanceFingerprint(),
    panelUrl: publicBaseUrl(),
    state: row.state as SourceMoveState,
    counts: { teams, users, apps, databases, servers },
    servers: await serverSummaries(),
  };
}

async function countByServer(
  table: typeof appsTable | typeof databasesTable,
): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ serverId: table.serverId, n: sql<number>`count(*)::int` })
    .from(table)
    .groupBy(table.serverId);
  return new Map(rows.map((r) => [r.serverId, Number(r.n)]));
}

function roleOf(s: Server): MoveServerSummary["role"] {
  if (s.importOnly) return "import";
  if (s.storageOnly) return "storage";
  if (s.buildOnly) return "build";
  return "workloads";
}

async function serverSummaries(): Promise<MoveServerSummary[]> {
  const [all, apps, databases] = await Promise.all([
    listAllServers(),
    countByServer(appsTable),
    countByServer(databasesTable),
  ]);
  const self = deploHostSelfAddresses();
  return Promise.all(
    all.map(async (s) => {
      const enrolled = Boolean(s.agent?.certFingerprint);
      const probe = enrolled ? await probeAgent(s.id) : null;
      return {
        id: s.id,
        name: s.name,
        address: s.ip || s.host,
        port: s.agent?.port ?? null,
        role: roleOf(s),
        isPanelHost: isDeploHostServer(s, self),
        enrolled,
        reachable: probe !== null,
        canHandOver: !!probe?.capabilities.includes(CERT_RENEWAL_CAPABILITY),
        agentVersion: probe?.version || s.agent?.version || null,
        apps: apps.get(s.id) ?? 0,
        databases: databases.get(s.id) ?? 0,
      };
    }),
  );
}

// "queued" is not live: the migration runner does not promote anything while frozen.
const migrationRunning = () => eq(migrationRuns.status, "running");

export async function moveFreeze(
  caller: MoveCaller,
): Promise<{ state: SourceMoveState }> {
  const row = await auth(caller);
  if (row.state === "frozen" || row.state === "moved")
    return { state: row.state };
  const frozen = await instanceFrozen();
  if (frozen) throw new MoveRefusedError(frozen.message, 409);
  // A migration writes for minutes past the freeze; the settle wait below is for what starts in the gap.
  if ((await getDb().$count(migrationRuns, migrationRunning())) > 0)
    throw new MoveRefusedError(
      "A migration is running on this Deplo. Finish or stop it, then start the move again.",
      409,
    );
  const [paused] = await getDb()
    .update(deploMoves)
    .set({ state: "frozen", updatedAt: nowIso() })
    .where(and(eq(deploMoves.id, row.id), eq(deploMoves.state, "bound")))
    .returning({ id: deploMoves.id });
  invalidateFrozen();
  if (paused)
    await recordForEveryTeam(
      `Paused changes to move this Deplo to ${peerOf(row)}`,
      row.startedBy,
    );
  return { state: "frozen" };
}

// The settle wait stays under the 5-minute header deadline of the new Deplo's fetch.
const TIMING = {
  settleMs: 4 * 60_000,
  pollMs: 2_000,
  graceMs: FROZEN_CACHE_MS + 1_000,
};
let timing = { ...TIMING };

export function __setMoveTimingForTest(t: Partial<typeof TIMING> = {}): void {
  timing = { ...TIMING, ...t };
}

let dumper: (() => AsyncIterable<string>) | null = null;

export function __setDumperForTest(fn?: () => AsyncIterable<string>): void {
  dumper = fn ?? null;
}

async function inFlight(): Promise<number> {
  const db = getDb();
  const counts = await Promise.all([
    db.$count(deploymentsTable, eq(deploymentsTable.status, "building")),
    db.$count(backupRuns, eq(backupRuns.status, "running")),
    db.$count(migrationRuns, migrationRunning()),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

// A mutation that passed the gate a moment before the freeze, or a build still running, lands before the snapshot.
async function settle(frozenAt: string): Promise<void> {
  const graceUntil = Date.parse(frozenAt) + timing.graceMs;
  const deadline = Date.now() + timing.settleMs;
  while (Date.now() < deadline) {
    if (Date.now() >= graceUntil && (await inFlight()) === 0) return;
    await new Promise((r) => setTimeout(r, timing.pollMs));
  }
}

async function* dumpLines(): AsyncIterable<string> {
  if (dumper) {
    yield* dumper();
    return;
  }
  const { dumpInstance } = await import("./dump");
  yield* dumpInstance();
}

export async function moveDump(
  caller: MoveCaller,
): Promise<AsyncIterable<string>> {
  const row = await auth(caller);
  requireFrozen(row);
  await settle(row.updatedAt);
  return dumpLines();
}

async function serverToHandOver(
  moveId: string,
  serverId: string,
): Promise<{ id: string; name: string }> {
  const [server] = await getDb()
    .select({
      id: serversTable.id,
      name: serversTable.name,
      fingerprint: serversTable.agentCertFingerprint,
    })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  if (!server)
    throw new MoveRefusedError(
      `There is no server ${serverId} on the old Deplo.`,
      404,
    );
  if (!server.fingerprint)
    throw new MoveRefusedError(
      `${server.name} has no server agent to hand over.`,
      409,
    );
  const [done] = await getDb()
    .select({ state: deploMoveServers.state })
    .from(deploMoveServers)
    .where(
      and(
        eq(deploMoveServers.moveId, moveId),
        eq(deploMoveServers.serverId, serverId),
        eq(deploMoveServers.state, "handed_over"),
      ),
    )
    .limit(1);
  if (done)
    throw new MoveRefusedError(
      `${server.name} already answers to the new Deplo.`,
      409,
      true,
    );
  return { id: server.id, name: server.name };
}

async function withAgent<T>(
  server: { id: string; name: string },
  fn: (conn: AgentConnection) => Promise<T>,
): Promise<T> {
  let conn: AgentConnection | null = null;
  try {
    conn = await connectAgent(server.id);
    const hello = await conn.hello(HEALTH_HELLO_TIMEOUT_MS);
    if (!hello.capabilities?.includes(CERT_RENEWAL_CAPABILITY))
      throw new MoveRefusedError(
        `The server agent on ${server.name} is too old to be handed over. Update it first.`,
        409,
      );
    return await fn(conn);
  } catch (e) {
    if (e instanceof MoveRefusedError) throw e;
    const why = unreachableMessage(e) ?? (e as Error).message;
    // Never 502-504: the new Deplo reads those as this panel being down.
    throw new MoveRefusedError(`${server.name}: ${why}`, 409);
  } finally {
    conn?.close();
  }
}

export async function moveCsr(
  caller: MoveCaller,
  serverId: string,
): Promise<MoveCsrResponse> {
  const row = await auth(caller);
  requireFrozen(row);
  const server = await serverToHandOver(row.id, serverId);
  return withAgent(server, async (conn) => {
    const { csrPem } = await conn.renewalCsr();
    return { csrPem };
  });
}

function parseCert(pem: string, what: string): X509Certificate {
  const refused = new MoveRefusedError(
    `The ${what} is not a certificate.`,
    400,
  );
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw refused;
  try {
    return new X509Certificate(pem);
  } catch {
    throw refused;
  }
}

function assertCertPair(certPem: string, caPem: string): void {
  const cert = parseCert(certPem, "server certificate");
  const ca = parseCert(caPem, "certificate authority");
  if (!ca.ca)
    throw new MoveRefusedError(
      "The certificate authority is not a certificate authority.",
      400,
    );
  if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey))
    throw new MoveRefusedError(
      "The server certificate was not signed by the certificate authority sent with it.",
      400,
    );
}

type ServerState = "waiting" | "handed_over" | "failed";

async function serverState(
  moveId: string,
  serverId: string,
): Promise<ServerState | null> {
  const [r] = await getDb()
    .select({ state: deploMoveServers.state })
    .from(deploMoveServers)
    .where(
      and(
        eq(deploMoveServers.moveId, moveId),
        eq(deploMoveServers.serverId, serverId),
      ),
    )
    .limit(1);
  return (r?.state as ServerState | undefined) ?? null;
}

async function markServer(
  moveId: string,
  server: { id: string; name: string },
  state: ServerState,
  error = "",
  db: DrizzleClient | DbTx = getDb(),
): Promise<void> {
  const position = await db.$count(
    deploMoveServers,
    eq(deploMoveServers.moveId, moveId),
  );
  await db
    .insert(deploMoveServers)
    .values({
      moveId,
      serverId: server.id,
      name: server.name,
      position,
      state,
      error,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [deploMoveServers.moveId, deploMoveServers.serverId],
      set: { state, error, updatedAt: nowIso() },
    });
}

// Marks the server `waiting` under the move row's lock, as a thaw or a resume takes it: each sees the other.
async function beginInstall(
  moveId: string,
  server: { id: string; name: string },
): Promise<void> {
  const live = await getDb().transaction(async (tx) => {
    const [frozen] = await tx
      .select({ id: deploMoves.id })
      .from(deploMoves)
      .where(and(eq(deploMoves.id, moveId), eq(deploMoves.state, "frozen")))
      .for("update");
    if (frozen) await markServer(moveId, server, "waiting", "", tx);
    return Boolean(frozen);
  });
  if (!live)
    throw new MoveRefusedError(
      "This move is no longer running on the old Deplo.",
      409,
    );
}

export async function moveInstall(
  caller: MoveCaller,
  req: MoveInstallRequest,
): Promise<{ ok: true }> {
  const row = await auth(caller);
  requireFrozen(row);
  const certPem = String(req.certPem ?? "");
  const caPem = String(req.caPem ?? "");
  assertCertPair(certPem, caPem);
  const server = await serverToHandOver(row.id, String(req.serverId ?? ""));

  // While in this set, a cancel never reads the server's `waiting` as an install that did not happen.
  const installing = installsInFlight();
  if (installing.has(server.id))
    throw new MoveRefusedError(
      `${server.name} is being handed over already.`,
      409,
    );
  installing.add(server.id);
  try {
    return await install(row, server, certPem, caPem);
  } finally {
    installing.delete(server.id);
  }
}

async function install(
  row: SourceMoveRow,
  server: { id: string; name: string },
  certPem: string,
  caPem: string,
): Promise<{ ok: true }> {
  // "waiting" blocks a cancel: once the request leaves, the agent may answer to the new Deplo only.
  const before = await serverState(row.id, server.id);
  await beginInstall(row.id, server);
  let inDoubt = false;
  try {
    await withAgent(server, async (conn) => {
      inDoubt = true;
      const res = await conn.installRenewedCert({ certPem, caPem });
      inDoubt = false;
      if (!res.ok)
        throw new MoveRefusedError(
          `${server.name} refused the new certificate: ${res.error}`,
          409,
        );
    });
  } catch (e) {
    const state = inDoubt || before === "waiting" ? "waiting" : "failed";
    await markServer(row.id, server, state, (e as Error).message);
    throw e;
  }
  await markServer(row.id, server, "handed_over");
  await recordForEveryTeam(
    `Handed server ${server.name} over to the Deplo at ${peerOf(row)}`,
    row.startedBy,
  );
  return { ok: true };
}

export async function moveFinish(
  caller: MoveCaller,
  req: MoveFinishRequest,
): Promise<{ state: SourceMoveState }> {
  const row = await auth(caller);
  if (row.state === "moved") return { state: "moved" };
  requireFrozen(row);

  const handed = await getDb()
    .select({ serverId: deploMoveServers.serverId })
    .from(deploMoveServers)
    .where(
      and(
        eq(deploMoveServers.moveId, row.id),
        eq(deploMoveServers.state, "handed_over"),
      ),
    );
  const done = new Set(handed.map((h) => h.serverId));
  // An install whose answer was lost: this Deplo can no longer dial that agent, the new one confirmed it.
  const confirmed = new Set((req.handedOver ?? []).map(String));
  const enrolled = await enrolledServers();
  for (const s of enrolled) {
    if (done.has(s.id) || !confirmed.has(s.id)) continue;
    await markServer(row.id, s, "handed_over");
    done.add(s.id);
    await recordForEveryTeam(
      `Handed server ${s.name} over to the Deplo at ${peerOf(row)}`,
      row.startedBy,
    );
  }
  const left = enrolled.filter((s) => !done.has(s.id));
  if (left.length > 0)
    throw new MoveRefusedError(
      `Not every server answers to the new Deplo yet: ${left.map((s) => s.name).join(", ")}.`,
      409,
    );

  const peerUrl = originOf(req.movedTo) ?? row.peerUrl;
  const now = nowIso();
  await getDb()
    .update(deploMoves)
    .set({ state: "moved", peerUrl, finishedAt: now, updatedAt: now })
    .where(and(eq(deploMoves.id, row.id), eq(deploMoves.state, "frozen")));
  invalidateFrozen();
  await recordForEveryTeam(
    `Moved this Deplo to ${peerUrl ?? "another machine"}`,
    row.startedBy,
  );
  return { state: "moved" };
}

export async function moveThaw(caller: MoveCaller): Promise<{ ok: true }> {
  const row = await auth(caller);
  await thawSourceMove(row, row.startedBy);
  return { ok: true };
}
