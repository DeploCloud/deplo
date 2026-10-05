import "server-only";

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";

import { and, desc, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import {
  teams as teamsTable,
  users as usersTable,
} from "../../db/schema/control-plane/identity";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { sha256Hex } from "../../crypto";
import { composeTruthy } from "../../deploy/compose-lint/document";
import { stackFilesDir } from "../../deploy/deploy-key";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import {
  MOVE_CODE_PREFIX,
  MOVE_PROTOCOL,
  type MoveHello,
  type MoveHostPathRequest,
  type MoveImageRequest,
  type MovePauseResponse,
  type MoveServerSummary,
  type MoveVolumeRequest,
  type MoveWorkloadInfo,
  type SourceMoveState,
  type WorkloadRef,
} from "../../deplo-move/protocol";
import { schemaTag } from "../../deplo-move/schema-tag";
import { connectAgent } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { HEALTH_HELLO_TIMEOUT_MS } from "../../infra/agent-client/deadlines";
import {
  AgentUnreachableError,
  toAgentError,
} from "../../infra/agent-client/errors";
import { VOLUME_USAGE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { unreachableMessage } from "../../infra/server-health";
import { nowIso } from "../../ids";
import { instanceFingerprint } from "../../migration/deplo/instance";
import {
  composeHostMounts,
  isDataHostPath,
  isUnderPath,
  normalizePath,
} from "../../migration/map/volume-discovery";
import { publicBaseUrl } from "../../public-url";
import type { App } from "../../types/app";
import type { Server } from "../../types/server";
import { appBuildsItsOwnImage } from "../../utils";
import { DEPLO_VERSION } from "../../version";
import yaml from "../../yaml";
import { loadAppGraph } from "../app-graph-load";
import { dbVolumeHostName } from "../databases/stack";
import {
  appHasFilesDir,
  appMoveVolumeNames,
  appOwnVolumeNames,
  assertSafeVolumeNames,
} from "../project-backup-descriptor";
import { listAllServers } from "../servers/roster";
import { cancelSourceMove } from "./source";
import {
  holdingLease,
  pauseWorkload,
  renewLease,
  resumeAllPauses,
  resumeWorkload,
} from "./source-pauses";
import {
  MoveRefusedError,
  peerOf,
  recordForEveryTeam,
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
const FINISHED =
  "This copy already finished. Copying this Deplo again needs a new move code.";

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
  return row;
}

function auth(caller: MoveCaller): Promise<SourceMoveRow> {
  return authenticateMoveCode(caller.code, caller.peerInstance, caller.peerUrl);
}

function requireLive(row: SourceMoveRow): void {
  if (row.state === "done") throw new MoveRefusedError(FINISHED, 409);
}

function requireCopying(row: SourceMoveRow): void {
  requireLive(row);
  if (row.state !== "copying")
    throw new MoveRefusedError(
      "The copy has not started: the old Deplo has not sent its data yet.",
      409,
    );
}

// Never 502-504: the new Deplo reads those as this panel being down. 424 says a server agent did not answer.
function toRefusal(e: unknown, who?: string): unknown {
  if (e instanceof MoveRefusedError) return e;
  const code = (e as { code?: unknown } | null)?.code;
  // A database or file-system error stays internal: the route masks it.
  if (typeof code === "string" || (e as Error)?.name === "DrizzleQueryError")
    return e;
  const err = toAgentError(e);
  const prefix = who ? `${who}: ` : "";
  if (err instanceof AgentUnreachableError)
    return new MoveRefusedError(
      prefix + (unreachableMessage(err) ?? err.message),
      424,
    );
  const agentCode = typeof code === "number" ? code : undefined;
  return new MoveRefusedError(
    prefix + err.message,
    agentCode === 5 ? 404 : 409,
    agentCode,
  );
}

// For the route: what a data stream that failed before its first byte answers.
export function dataRefusal(e: unknown): unknown {
  return toRefusal(e);
}

async function probeAgent(
  serverId: string,
): Promise<{ version: string } | null> {
  let conn: AgentConnection | null = null;
  try {
    conn = await connectAgent(serverId);
    const hello = await conn.hello(HEALTH_HELLO_TIMEOUT_MS);
    return { version: hello.agentVersion };
  } catch {
    return null;
  } finally {
    conn?.close();
  }
}

export async function moveHello(caller: MoveCaller): Promise<MoveHello> {
  const row = await auth(caller);
  requireLive(row);
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

async function databaseHostsByServer(): Promise<
  Map<string, NonNullable<MoveServerSummary["databaseHosts"]>>
> {
  const rows = await getDb()
    .select({
      id: databasesTable.id,
      name: databasesTable.name,
      host: databasesTable.host,
      serverId: databasesTable.serverId,
    })
    .from(databasesTable)
    .orderBy(databasesTable.id);
  const out = new Map<string, { id: string; name: string; host: string }[]>();
  for (const { serverId, ...db } of rows)
    out.set(serverId, [...(out.get(serverId) ?? []), db]);
  return out;
}

async function serverSummaries(): Promise<MoveServerSummary[]> {
  const [all, apps, databases, hosts] = await Promise.all([
    listAllServers(),
    countByServer(appsTable),
    countByServer(databasesTable),
    databaseHostsByServer(),
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
        agentVersion: probe?.version || s.agent?.version || null,
        apps: apps.get(s.id) ?? 0,
        databases: databases.get(s.id) ?? 0,
        databaseHosts: hosts.get(s.id) ?? [],
      };
    }),
  );
}

let dumper: (() => AsyncIterable<string>) | null = null;

export function __setDumperForTest(fn?: () => AsyncIterable<string>): void {
  dumper = fn ?? null;
}

async function* dumpLines(): AsyncIterable<string> {
  if (dumper) {
    yield* dumper();
    return;
  }
  const { dumpInstance } = await import("./dump");
  yield* dumpInstance();
}

// One repeatable-read snapshot of a Deplo that keeps running: nothing here pauses for it.
export async function moveDump(
  caller: MoveCaller,
): Promise<AsyncIterable<string>> {
  const row = await auth(caller);
  requireLive(row);
  const [started] = await getDb()
    .update(deploMoves)
    .set({ state: "copying", updatedAt: nowIso() })
    .where(and(eq(deploMoves.id, row.id), eq(deploMoves.state, "bound")))
    .returning({ id: deploMoves.id });
  if (started)
    await recordForEveryTeam(
      `Copying this Deplo to ${peerOf(row)}`,
      row.startedBy,
    );
  return dumpLines();
}

interface Workload {
  ref: WorkloadRef;
  name: string;
  // The stack's name on its server: an app's slug, a database's host.
  slug: string;
  serverId: string;
  app: App | null;
}

function refOf(raw: Partial<WorkloadRef>): WorkloadRef {
  const id = String(raw.id ?? "").trim();
  if ((raw.kind !== "app" && raw.kind !== "database") || !id)
    throw new MoveRefusedError("Name an app or a database: kind and id.", 400);
  return { kind: raw.kind, id };
}

async function workloadOf(raw: Partial<WorkloadRef>): Promise<Workload> {
  const ref = refOf(raw);
  if (ref.kind === "app") {
    const app = await loadAppGraph(ref.id);
    if (!app)
      throw new MoveRefusedError(
        `There is no app ${ref.id} on the old Deplo.`,
        404,
      );
    return {
      ref,
      name: app.name,
      slug: app.slug,
      serverId: app.serverId,
      app,
    };
  }
  const [db] = await getDb()
    .select({
      name: databasesTable.name,
      host: databasesTable.host,
      serverId: databasesTable.serverId,
    })
    .from(databasesTable)
    .where(eq(databasesTable.id, ref.id))
    .limit(1);
  if (!db)
    throw new MoveRefusedError(
      `There is no database ${ref.id} on the old Deplo.`,
      404,
    );
  return {
    ref,
    name: db.name,
    slug: db.host,
    serverId: db.serverId,
    app: null,
  };
}

async function onServer<T>(
  w: Workload,
  fn: (conn: AgentConnection) => Promise<T>,
): Promise<T> {
  let conn: AgentConnection | null = null;
  try {
    conn = await connectAgent(w.serverId);
    return await fn(conn);
  } catch (e) {
    throw toRefusal(e, w.name);
  } finally {
    conn?.close();
  }
}

async function isRunning(conn: AgentConnection, w: Workload): Promise<boolean> {
  const instances = await conn.listInstances(w.ref.id, w.slug, "");
  return instances.some((i) => i.running);
}

// The same names a server move copies: the live stack's volumes, or the app's own when it has no stack.
async function volumesOf(
  conn: AgentConnection,
  w: Workload,
): Promise<string[]> {
  if (!w.app) return [dbVolumeHostName(w.slug)];
  const stack = await conn.readStack(w.slug);
  const names = stack.exists
    ? appMoveVolumeNames(w.app, stack.yaml)
    : appOwnVolumeNames(w.app);
  assertSafeVolumeNames(w.slug, names);
  return [...new Set(names)];
}

async function presentOnly(
  conn: AgentConnection,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return names;
  const hello = await conn.hello(HEALTH_HELLO_TIMEOUT_MS);
  if (!hello.capabilities?.includes(VOLUME_USAGE_CAPABILITY)) return names;
  const usage = await conn.volumeUsage(names);
  return names.filter((n) => usage.has(n));
}

// The new side WIPES a host path before filling it, so anything the server itself runs on is never one.
const SERVER_OWNED = [
  "/var/lib/docker",
  "/var/lib/containerd",
  "/var/run",
  "/run",
  "/var/lib/deplo-agent",
  "/opt/deplo",
  "/data",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/usr",
  "/bin",
  "/sbin",
];

// Inside, equal to, or a parent of a server path (`/var` holds `/var/lib/docker`).
function isServerOwned(path: string): boolean {
  if (path === "/" || !isDataHostPath(path) || /^\/lib[^/]*(\/|$)/.test(path))
    return true;
  return SERVER_OWNED.some(
    (p) => p === path || isUnderPath(path, p) || isUnderPath(p, path),
  );
}

const canonicalPath = (p: string) => normalizePath(posix.normalize(p.trim()));

// Host path -> written by some mount. A path only ever bound read-only is configuration the app reads, not data.
function composeBindModes(compose: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  let doc: { services?: Record<string, { volumes?: unknown }> } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return out;
  }
  for (const svc of Object.values(doc?.services ?? {})) {
    if (!Array.isArray(svc?.volumes)) continue;
    for (const raw of svc.volumes) {
      let src: string | undefined;
      let writable = true;
      if (typeof raw === "string") {
        const [from, , mode] = raw.split(":");
        src = from?.trim();
        writable = !(mode ?? "").split(",").includes("ro");
      } else if (raw && typeof raw === "object") {
        const m = raw as { source?: unknown; read_only?: unknown };
        src = typeof m.source === "string" ? m.source.trim() : undefined;
        writable = !composeTruthy(m.read_only);
      }
      if (!src?.startsWith("/")) continue;
      const path = canonicalPath(src);
      out.set(path, (out.get(path) ?? false) || writable);
    }
  }
  return out;
}

function hostPathsOf(app: App): {
  copied: { path: string; allowFile: boolean }[];
  skipped: string[];
} {
  const writable = new Map<string, boolean>();
  const add = (path: string, w: boolean) =>
    writable.set(path, (writable.get(path) ?? false) || w);
  for (const v of app.volumes ?? [])
    if (v.type === "host" && v.hostPath?.trim())
      add(canonicalPath(v.hostPath), !v.readOnly);
  const modes = composeBindModes(app.compose ?? "");
  for (const m of composeHostMounts(app.compose ?? "", stackFilesDir(app.slug)))
    if (!m.stackRelative) {
      const path = canonicalPath(m.hostPath);
      add(path, modes.get(path) ?? true);
    }
  const copied: { path: string; allowFile: boolean }[] = [];
  const skipped: string[] = [];
  for (const [path, w] of writable)
    if (w && !isServerOwned(path)) copied.push({ path, allowFile: true });
    else skipped.push(path);
  return { copied, skipped };
}

async function liveImage(
  app: App,
): Promise<{ ref: string; deploymentId: string } | null> {
  if (!appBuildsItsOwnImage(app)) return null;
  const [dep] = await getDb()
    .select({
      id: deploymentsTable.id,
      imageRef: deploymentsTable.imageRef,
      rollbackOf: deploymentsTable.rollbackOf,
      serverId: deploymentsTable.serverId,
    })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.appId, app.id),
        eq(deploymentsTable.environment, "production"),
        eq(deploymentsTable.status, "ready"),
      ),
    )
    .orderBy(desc(deploymentsTable.createdAt), desc(deploymentsTable.seq))
    .limit(1);
  if (!dep?.imageRef) return null;
  // The image stays on the server that built it.
  if (dep.serverId && dep.serverId !== app.serverId) return null;
  return { ref: dep.imageRef, deploymentId: dep.rollbackOf ?? dep.id };
}

// lib/deploy/upload.ts: /data/uploads/<appId>/<id>/archive.<ext>.
async function uploadOf(
  app: App,
): Promise<{ path: string; filename: string } | null> {
  if (app.source !== "upload" || !app.upload?.path) return null;
  const root = resolve(
    join(process.env.DEPLO_DATA_DIR || "/data", "uploads", app.id),
  );
  const path = resolve(app.upload.path);
  if (!path.startsWith(root + sep)) return null;
  try {
    if (!(await stat(path)).isFile()) return null;
  } catch {
    return null;
  }
  return { path, filename: app.upload.filename };
}

export async function moveWorkload(
  caller: MoveCaller,
  raw: Partial<WorkloadRef>,
): Promise<MoveWorkloadInfo> {
  const row = await auth(caller);
  requireCopying(row);
  const w = await workloadOf(raw);
  const live = await onServer(w, async (conn) => ({
    running: await isRunning(conn, w),
    volumes: await presentOnly(conn, await volumesOf(conn, w)),
  }));
  const app = w.app;
  const host = app ? hostPathsOf(app) : { copied: [], skipped: [] };
  return {
    ...w.ref,
    name: w.name,
    slug: w.slug,
    serverId: w.serverId,
    running: live.running,
    volumes: live.volumes,
    files: app ? appHasFilesDir(app) : false,
    hostPaths: host.copied,
    skippedHostPaths: host.skipped,
    image: app ? await liveImage(app) : null,
    upload: app
      ? await uploadOf(app).then((u) => (u ? { filename: u.filename } : null))
      : null,
  };
}

export async function movePause(
  caller: MoveCaller,
  raw: Partial<WorkloadRef>,
): Promise<MovePauseResponse> {
  const row = await auth(caller);
  requireCopying(row);
  const w = await workloadOf(raw);
  try {
    return await pauseWorkload(
      row.id,
      { ref: w.ref, name: w.name, serverId: w.serverId, stack: w.slug },
      () => onServer(w, (conn) => isRunning(conn, w)),
    );
  } catch (e) {
    throw toRefusal(e, w.name);
  }
}

// `resumed: false`: there was no lease to give back - it lapsed, so the workload already started again.
export async function moveResume(
  caller: MoveCaller,
  raw: Partial<WorkloadRef>,
): Promise<{ resumed: boolean }> {
  const row = await auth(caller);
  requireLive(row);
  const ref = refOf(raw);
  try {
    return { resumed: await resumeWorkload(row.id, ref) };
  } catch (e) {
    throw toRefusal(e);
  }
}

export interface MoveDataStream {
  chunks: AsyncIterable<Buffer>;
  close: () => void;
  // The `upload` step only: the archive's own name, for MOVE_FILENAME_HEADER.
  filename?: string;
}

async function dataWorkload(
  caller: MoveCaller,
  raw: Partial<WorkloadRef>,
): Promise<{ row: SourceMoveRow; w: Workload }> {
  const row = await auth(caller);
  requireCopying(row);
  const w = await workloadOf(raw);
  await renewLease(row.id, w.ref);
  return { row, w };
}

// The stream is lazy: an agent that refuses it does so on the first chunk, which the route reads before answering.
async function openOn(
  row: SourceMoveRow,
  w: Workload,
  serverId: string,
  open: (conn: AgentConnection) => Promise<AsyncIterable<Buffer>>,
): Promise<MoveDataStream> {
  let conn: AgentConnection | null = null;
  try {
    conn = await connectAgent(serverId);
    const chunks = await open(conn);
    const opened = conn;
    return {
      chunks: holdingLease(row.id, w.ref, chunks),
      close: () => opened.close(),
    };
  } catch (e) {
    conn?.close();
    throw toRefusal(e, w.name);
  }
}

// 409, never 404: the new Deplo reads a 404 as data that is simply not there, and copies nothing in its place.
const notOwned = (message: string) => new MoveRefusedError(message, 409);

export async function moveVolume(
  caller: MoveCaller,
  req: Partial<MoveVolumeRequest>,
): Promise<MoveDataStream> {
  const { row, w } = await dataWorkload(caller, req);
  const volume = String(req.volume ?? "");
  return openOn(row, w, w.serverId, async (conn) => {
    const owned = new Set(await volumesOf(conn, w));
    if (w.app) for (const v of appOwnVolumeNames(w.app)) owned.add(v);
    if (!owned.has(volume))
      throw notOwned(`${w.name} has no volume ${volume || "by that name"}.`);
    return conn.exportVolume(volume);
  });
}

export async function moveHostPath(
  caller: MoveCaller,
  req: Partial<MoveHostPathRequest>,
): Promise<MoveDataStream> {
  const { row, w } = await dataWorkload(caller, req);
  const asked = String(req.path ?? "").trim();
  const paths = w.app ? hostPathsOf(w.app) : { copied: [], skipped: [] };
  const path = asked ? canonicalPath(asked) : "";
  if (paths.skipped.includes(path))
    throw notOwned(
      isServerOwned(path)
        ? `${path} belongs to the server itself, so it is not copied.`
        : `${path} is only mounted read-only, so it is not copied.`,
    );
  const mount = path ? paths.copied.find((m) => m.path === path) : undefined;
  if (!mount) throw notOwned(`${w.name} does not mount ${asked || "it"}.`);
  return openOn(row, w, w.serverId, async (conn) =>
    conn.exportHostPath(mount.path, req.allowFile === true && mount.allowFile),
  );
}

export async function moveFiles(
  caller: MoveCaller,
  raw: Partial<WorkloadRef>,
): Promise<MoveDataStream> {
  const { row, w } = await dataWorkload(caller, raw);
  if (!w.app || !appHasFilesDir(w.app))
    throw notOwned(`${w.name} has no files of its own.`);
  return openOn(row, w, w.serverId, async (conn) => conn.exportFiles(w.slug));
}

export async function moveImage(
  caller: MoveCaller,
  req: Partial<MoveImageRequest>,
): Promise<MoveDataStream> {
  const { row, w } = await dataWorkload(caller, req);
  const imageRef = String(req.imageRef ?? "").trim();
  const [dep] =
    w.app && imageRef
      ? await getDb()
          .select({ serverId: deploymentsTable.serverId })
          .from(deploymentsTable)
          .where(
            and(
              eq(deploymentsTable.appId, w.ref.id),
              eq(deploymentsTable.imageRef, imageRef),
              eq(deploymentsTable.status, "ready"),
            ),
          )
          .limit(1)
      : [];
  if (!dep) throw notOwned(`${w.name} has no image ${imageRef || "to copy"}.`);
  // Never removed after the export: the old Deplo keeps running it.
  return openOn(row, w, dep.serverId ?? w.serverId, async (conn) =>
    conn.exportImage(imageRef, false),
  );
}

export async function moveUpload(
  caller: MoveCaller,
  raw: Partial<WorkloadRef>,
): Promise<MoveDataStream & { filename: string }> {
  const { row, w } = await dataWorkload(caller, raw);
  const archive = w.app ? await uploadOf(w.app) : null;
  if (!archive) throw notOwned(`${w.name} has no uploaded archive.`);
  const file = createReadStream(archive.path);
  return {
    chunks: holdingLease(row.id, w.ref, file as AsyncIterable<Buffer>),
    close: () => file.destroy(),
    filename: archive.filename,
  };
}

export async function moveFinish(
  caller: MoveCaller,
): Promise<{ state: SourceMoveState }> {
  const row = await auth(caller);
  // Idempotent: a finish whose answer was lost is asked again.
  if (row.state === "done") return { state: "done" };
  requireCopying(row);
  await resumeAllPauses(row.id);
  const now = nowIso();
  const [done] = await getDb()
    .update(deploMoves)
    .set({ state: "done", finishedAt: now, updatedAt: now })
    .where(and(eq(deploMoves.id, row.id), eq(deploMoves.state, "copying")))
    .returning({ id: deploMoves.id });
  if (done)
    await recordForEveryTeam(
      `Copied this Deplo to ${peerOf(row)}`,
      row.startedBy,
    );
  return { state: "done" };
}

export async function moveCancel(caller: MoveCaller): Promise<{ ok: true }> {
  const row = await auth(caller);
  requireLive(row);
  await cancelSourceMove(row, row.startedBy);
  return { ok: true };
}
