import "server-only";

import { X509Certificate } from "node:crypto";
import net from "node:net";

import { and, desc, eq, inArray } from "drizzle-orm";

import { DEFAULT_AGENT_PORT } from "../../agent/bootstrap";
import { caCertPem } from "../../agent/pki";
import { getCurrentUser } from "../../auth/current-user";
import { isSetupNeeded, logSetupLink, setupKey } from "../../auth/setup";
import { encryptSecret, randomToken } from "../../crypto";
import { getDb } from "../../db/client";
import journal from "../../db/migrations/meta/_journal.json";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import {
  teams as teamsTable,
  users as usersTable,
} from "../../db/schema/control-plane/identity";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import * as moveClient from "../../deplo-move/client";
import {
  MOVE_CODE_PREFIX,
  MOVE_PROTOCOL,
  type MoveHello,
  type MoveServerState,
  type MoveServerSummary,
  type TargetMoveState,
} from "../../deplo-move/protocol";
import { schemaTag } from "../../deplo-move/schema-tag";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import { nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import { instanceFingerprint } from "../../migration/deplo/instance";
import { publicBaseUrl } from "../../public-url";
import { sourceAgentReachable } from "../agent-reach";
import { wipeForMove } from "./restore";
import {
  NO_PANEL_ADDRESS,
  activeMoveRun,
  credentialOf,
  finishWithoutOldDeplo,
  launchMove,
  markServer,
  moveServerRows,
  setMoveState,
  targetMoveRow,
  type TargetMoveRow,
  type TargetMoveServerRow,
} from "./runner";

// The new Deplo's side of a Deplo move (ADR-0035).

export interface MovePreviewServer {
  id: string;
  name: string;
  address: string;
  port: number | null;
  role: MoveServerSummary["role"];
  isPanelHost: boolean;
  enrolled: boolean;
  agentVersion: string | null;
  apps: number;
  databases: number;
  // What keeps this server from being handed over, in one sentence; null when nothing does.
  problem: string | null;
}

export interface TargetMovePreview {
  id: string;
  peerUrl: string;
  version: string;
  counts: MoveHello["counts"];
  servers: MovePreviewServer[];
  // Every server problem, each naming its server. startMove refuses while any remains.
  problems: string[];
  warnings: string[];
  canStart: boolean;
}

export type MoveStatusStepKey = "copy" | "servers" | "finish";
export type MoveStatusStepState = "waiting" | "running" | "done" | "failed";

export interface MoveStatusServer {
  id: string;
  name: string;
  state: MoveServerState;
  // Why it failed, or a note on a handed-over server this machine cannot reach yet.
  error: string;
}

export interface MoveStatus {
  id: string;
  state: TargetMoveState;
  error: string;
  steps: { key: MoveStatusStepKey; state: MoveStatusStepState }[];
  servers: MoveStatusServer[];
  peerUrl: string;
  // A cancel that left no account hands back the setup link, or the way in would be the server log.
  setupPath: string | null;
  rowsCopied: number;
  unreadable: number;
  startedBy: string;
  createdAt: string;
  finishedAt: string | null;
  canRetry: boolean;
  canCancel: boolean;
  // The copy landed and the move stopped: finishing here leaves the servers not handed over behind.
  canFinishWithoutSource: boolean;
}

const NO_SUCH_MOVE = "There is no such move on this Deplo.";
const ALREADY_UNDER_WAY =
  "A move into this Deplo is already under way: open it to retry or cancel it.";
const ANOTHER_RUNNING = "Another move is running on this Deplo right now.";
const STILL_RUNNING =
  "The move is still running: wait for it to stop, then cancel it.";

const OPEN_STATES: TargetMoveState[] = [
  "connected",
  "copying",
  "handing_over",
  "failed",
];

type PortProbe = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<boolean>;

const PORT_PROBE_TIMEOUT_MS = 5_000;

function tcpReachable(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host.replace(/^\[|\]$/g, ""), port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

let portProbe: PortProbe = tcpReachable;

export function __setPortProbeForTest(fn?: PortProbe): void {
  portProbe = fn ?? tcpReachable;
}

// https only: the copy carries every secret. Instance-admin only, so a private address is allowed.
function moveBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter the old Deplo's address.");
  if (/^http:\/\//i.test(trimmed))
    throw new Error(
      "Use the old Deplo's https address: a move carries every secret, so it never runs over plain http.",
    );
  let u: URL;
  try {
    u = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    throw new Error("That is not a web address.");
  }
  if (u.protocol !== "https:")
    throw new Error("Use the old Deplo's https address.");
  if (u.username || u.password)
    throw new Error(
      "Enter the old Deplo's address without a name or password in it.",
    );
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

// A move only goes into a fresh install: nothing of its own to lose under the copy.
async function emptinessProblem(): Promise<string | null> {
  const db = getDb();
  const [apps, databases, teams, users, servers] = await Promise.all([
    db.$count(appsTable),
    db.$count(databasesTable),
    db.$count(teamsTable),
    db.$count(usersTable),
    db
      .select({ ip: serversTable.ip, host: serversTable.host })
      .from(serversTable),
  ]);
  if (apps > 0 || databases > 0)
    return "Needs an empty Deplo, and this one already has apps or databases. Bring only some teams instead.";
  if (teams > 1 || users > 1)
    return "Needs an empty Deplo, and this one already has other teams or people. Bring only some teams instead.";
  const self = deploHostSelfAddresses();
  if (servers.some((s) => !isDeploHostServer(s, self)))
    return "Needs an empty Deplo, and this one already has servers of its own. Bring only some teams instead.";
  return null;
}

async function openTargetMove(): Promise<TargetMoveRow | null> {
  const [row] = await getDb()
    .select()
    .from(deploMoves)
    .where(
      and(
        eq(deploMoves.side, "target"),
        inArray(deploMoves.state, OPEN_STATES),
      ),
    )
    .orderBy(desc(deploMoves.createdAt))
    .limit(1);
  return row ?? null;
}

export async function targetMoveReadiness(): Promise<{
  ready: boolean;
  reason: string | null;
}> {
  await requireInstanceAdmin();
  const open = await openTargetMove();
  const reason =
    open && open.state !== "connected"
      ? ALREADY_UNDER_WAY
      : await emptinessProblem();
  return { ready: reason === null, reason };
}

function olderSide(hello: MoveHello): "old" | "this" {
  if (hello.protocol !== MOVE_PROTOCOL)
    return hello.protocol < MOVE_PROTOCOL ? "old" : "this";
  return journal.entries.some((e) => e.tag === hello.schema) ? "old" : "this";
}

async function serverProblem(
  s: MoveServerSummary,
  self: ReadonlySet<string>,
): Promise<string | null> {
  if (isDeploHostServer({ ip: s.address, host: s.address }, self))
    return `${s.name} is this machine: install the new Deplo on a machine the old one does not use.`;
  if (!s.enrolled) return null;
  if (!s.reachable)
    return `The old Deplo cannot reach ${s.name} right now: bring it back online, then check again.`;
  if (!s.canHandOver)
    return `${s.name} runs an older server agent: update it from the old Deplo's Servers page, then check again.`;
  const port = s.port ?? DEFAULT_AGENT_PORT;
  if (!(await portProbe(s.address, port, PORT_PROBE_TIMEOUT_MS)))
    return `This machine cannot reach ${s.name} at ${s.address}:${port}: let it through that server's firewall, then check again.`;
  return null;
}

interface Inspection {
  hello: MoveHello;
  servers: MovePreviewServer[];
  problems: string[];
  warnings: string[];
}

function hostOf(url: string | null): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

// Passkeys and webhook addresses are bound to the panel's address, not to the data.
function addressWarning(oldPanelUrl: string | null): string[] {
  const was = hostOf(oldPanelUrl);
  const now = hostOf(publicBaseUrl());
  return was && now && was !== now
    ? [
        `Passkeys and webhook addresses only keep working if ${was} points at this Deplo after the move.`,
      ]
    : [];
}

async function inspect(c: moveClient.MoveCredential): Promise<Inspection> {
  const hello = await moveClient.hello(c);
  if (hello.instance === instanceFingerprint())
    throw new Error(
      "That address is this Deplo: enter the address of the Deplo you are moving from.",
    );
  if (hello.state === "moved")
    throw new Error("That Deplo has already moved to another machine.");
  if (hello.protocol !== MOVE_PROTOCOL || hello.schema !== schemaTag())
    throw new Error(
      olderSide(hello) === "old"
        ? `The old Deplo runs an older version (${hello.version}): update it, then connect again.`
        : `This Deplo is older than the old one (${hello.version}): update this Deplo, then connect again.`,
    );
  const self = deploHostSelfAddresses();
  const servers = await Promise.all(
    hello.servers.map(async (s): Promise<MovePreviewServer> => ({
      id: s.id,
      name: s.name,
      address: s.address,
      port: s.port,
      role: s.role,
      isPanelHost: s.isPanelHost,
      enrolled: s.enrolled,
      agentVersion: s.agentVersion,
      apps: s.apps,
      databases: s.databases,
      problem: await serverProblem(s, self),
    })),
  );
  return {
    hello,
    servers,
    problems: servers.flatMap((s) => (s.problem ? [s.problem] : [])),
    warnings: [
      ...addressWarning(hello.panelUrl),
      ...servers
        .filter((s) => !s.enrolled && !s.problem)
        .map(
          (s) =>
            `${s.name} never finished connecting, so it is copied as it is.`,
        ),
    ],
  };
}

async function starterName(): Promise<string> {
  const user = await getCurrentUser();
  return user?.name || user?.username || "An instance admin";
}

export async function connectMove(input: {
  url: string;
  code: string;
}): Promise<TargetMovePreview> {
  await requireInstanceAdmin();
  const baseUrl = moveBaseUrl(input.url);
  const code = input.code.trim();
  if (!code.startsWith(MOVE_CODE_PREFIX))
    throw new Error(
      "That is not a move code: create one on the old Deplo under Settings, Migrations, Move this Deplo.",
    );
  if (!publicBaseUrl()) throw new Error(NO_PANEL_ADDRESS);
  const open = await openTargetMove();
  if (open && open.state !== "connected") throw new Error(ALREADY_UNDER_WAY);
  const empty = await emptinessProblem();
  if (empty) throw new Error(empty);

  const found = await inspect({ baseUrl, code });
  const now = nowIso();
  const id = open?.id ?? `dmv_${randomToken(24)}`;
  const values = {
    state: "connected" satisfies TargetMoveState,
    codeEnc: encryptSecret(code),
    peerUrl: baseUrl,
    peerInstance: found.hello.instance,
    startedBy: await starterName(),
    error: "",
    updatedAt: now,
  };
  await getDb()
    .insert(deploMoves)
    .values({ id, side: "target", createdAt: now, ...values })
    .onConflictDoUpdate({ target: deploMoves.id, set: values });
  return {
    id,
    peerUrl: baseUrl,
    version: found.hello.version,
    counts: found.hello.counts,
    servers: found.servers,
    problems: found.problems,
    warnings: found.warnings,
    canStart: found.problems.length === 0,
  };
}

export async function startMove(id: string): Promise<MoveStatus> {
  await requireInstanceAdmin();
  const row = await targetMoveRow(id);
  if (!row) throw new Error(NO_SUCH_MOVE);
  if (row.state !== "connected")
    throw new Error("This move has already started.");
  if (activeMoveRun()) throw new Error(ANOTHER_RUNNING);
  const empty = await emptinessProblem();
  if (empty) throw new Error(empty);
  const found = await inspect(credentialOf(row));
  if (found.problems.length) throw new Error(found.problems[0]);
  await setMoveState(id, "copying", {
    error: "",
    startedBy: await starterName(),
  });
  launchMove(id);
  return (await moveStatus(id))!;
}

// Public by id: the copy signs everyone out, so the move page cannot lean on a session.
export async function retryMove(id: string): Promise<MoveStatus> {
  const row = await targetMoveRow(id);
  if (!row) throw new Error(NO_SUCH_MOVE);
  if (activeMoveRun() === id) return (await moveStatus(id))!;
  if (row.state === "done") throw new Error("This move has already finished.");
  if (row.state === "cancelled")
    throw new Error("This move was cancelled: start a new one.");
  if (row.state === "connected")
    throw new Error("This move has not started yet.");
  if (activeMoveRun()) throw new Error(ANOTHER_RUNNING);
  const servers = await moveServerRows(id);
  await setMoveState(
    id,
    copyCommitted(row, servers) ? "handing_over" : "copying",
    {
      error: "",
    },
  );
  launchMove(id);
  return (await moveStatus(id))!;
}

function copyCommitted(
  row: TargetMoveRow,
  servers: TargetMoveServerRow[],
): boolean {
  return row.rowsCopied > 0 || servers.length > 0;
}

// Possible until the first server is handed over; after that a move only goes forward.
export async function cancelMove(id: string): Promise<MoveStatus> {
  const row = await targetMoveRow(id);
  if (!row) throw new Error(NO_SUCH_MOVE);
  if (row.state === "cancelled") return (await moveStatus(id))!;
  if (row.state === "done")
    throw new Error(
      "This move has finished, so it can no longer be cancelled.",
    );
  if (activeMoveRun() === id) throw new Error(STILL_RUNNING);
  const servers = await moveServerRows(id);
  if (servers.some((s) => s.state === "handed_over"))
    throw new Error(
      "A server already answers to this Deplo, so this move can only go forward: retry it instead.",
    );
  const unsure = await maybeHandedOver(servers);
  for (const s of unsure)
    if (await sourceAgentReachable(s.serverId)) {
      await markServer(id, s.serverId, "handed_over", "");
      throw new Error(
        `${s.name} already answers to this Deplo, so the move can only go forward.`,
      );
    }

  let note = "";
  try {
    await moveClient.thaw(credentialOf(row));
  } catch (e) {
    // An answer other than "unknown code" is the old Deplo refusing, and it decides.
    if (e instanceof moveClient.MoveRefusedError && e.status !== 401) throw e;
    if (!(e instanceof moveClient.MoveRefusedError)) {
      if (unsure.length)
        throw new Error(
          `The old Deplo cannot be reached, and ${nameList(unsure.map((s) => s.name))} may already answer to this Deplo. Try again once the old Deplo is back, or finish without it.`,
        );
      note =
        "The old Deplo could not be reached to resume it: cancel the move there too.";
    }
  }
  const copied =
    row.state !== "connected" &&
    (copyCommitted(row, servers) || (await emptinessProblem()) !== null);
  if (copied) await getDb().transaction((tx) => wipeForMove(tx));
  await setMoveState(id, "cancelled", { error: note, finishedAt: nowIso() });
  if (copied) await logSetupLink().catch(() => {});
  return (await moveStatus(id))!;
}

// The runner records this Deplo's certificate before it asks for the install, so the install may have happened.
async function maybeHandedOver(
  servers: TargetMoveServerRow[],
): Promise<TargetMoveServerRow[]> {
  const pending = servers.filter((s) => s.state !== "handed_over");
  if (pending.length === 0) return [];
  const rows = await getDb()
    .select({ id: serversTable.id, pem: serversTable.agentCertPem })
    .from(serversTable)
    .where(
      inArray(
        serversTable.id,
        pending.map((s) => s.serverId),
      ),
    );
  const ca = new X509Certificate(await caCertPem());
  const ours = new Set(
    rows.filter((r) => issuedBy(ca, r.pem)).map((r) => r.id),
  );
  return pending.filter((s) => ours.has(s.serverId));
}

// Every Deplo's CA has the same name, so only the signature tells this one's certificates apart.
function issuedBy(ca: X509Certificate, pem: string | null): boolean {
  if (!pem?.includes("BEGIN CERTIFICATE")) return false;
  try {
    const cert = new X509Certificate(pem);
    return cert.checkIssued(ca) && cert.verify(ca.publicKey);
  } catch {
    return false;
  }
}

function nameList(names: string[]): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function refuseWhileRunning(id: string): void {
  const running = activeMoveRun();
  if (running === id)
    throw new Error("The move is still running: wait for it to stop.");
  if (running) throw new Error(ANOTHER_RUNNING);
}

async function oldDeploAnswers(row: TargetMoveRow): Promise<boolean> {
  try {
    await moveClient.hello(credentialOf(row));
    return true;
  } catch {
    return false;
  }
}

// Public by id like retryMove: for an old Deplo that is gone for good, so this one stops waiting for it.
export async function finishMoveWithoutSource(id: string): Promise<MoveStatus> {
  const row = await targetMoveRow(id);
  if (!row) throw new Error(NO_SUCH_MOVE);
  if (row.state === "done") throw new Error("This move has already finished.");
  if (row.state !== "failed" || row.rowsCopied === 0)
    throw new Error(
      "Only a move that stopped after the copy can finish without the old Deplo.",
    );
  refuseWhileRunning(id);
  if (await oldDeploAnswers(row))
    throw new Error("The old Deplo answers again: try again instead.");
  refuseWhileRunning(id);
  const user = await getCurrentUser();
  const actor = user?.name || user?.username || "Someone on the move page";
  if (!(await finishWithoutOldDeplo(id, actor)))
    throw new Error("This move changed meanwhile: reload the page.");
  return (await moveStatus(id))!;
}

function stepsOf(
  row: TargetMoveRow,
  servers: TargetMoveServerRow[],
): MoveStatus["steps"] {
  const s = row.state as TargetMoveState;
  const copied = copyCommitted(row, servers);
  const allHanded = servers.every((x) => x.state === "handed_over");
  let copy: MoveStatusStepState = "waiting";
  let hand: MoveStatusStepState = "waiting";
  let finish: MoveStatusStepState = "waiting";
  if (s === "copying") copy = "running";
  else if (s === "handing_over") [copy, hand] = ["done", "running"];
  else if (s === "done")
    [copy, hand, finish] = ["done", allHanded ? "done" : "failed", "done"];
  else if (s === "failed" && !copied) copy = "failed";
  else if (s === "failed" && !allHanded) [copy, hand] = ["done", "failed"];
  else if (s === "failed") [copy, hand, finish] = ["done", "done", "failed"];
  return [
    { key: "copy", state: copy },
    { key: "servers", state: hand },
    { key: "finish", state: finish },
  ];
}

export async function moveStatus(id: string): Promise<MoveStatus | null> {
  const row = await targetMoveRow(id);
  if (!row) return null;
  const servers = await moveServerRows(id);
  const state = row.state as TargetMoveState;
  const running = activeMoveRun() === id;
  return {
    id: row.id,
    state,
    error: row.error,
    steps: stepsOf(row, servers),
    servers: servers.map((s) => ({
      id: s.serverId,
      name: s.name,
      state: s.state as MoveServerState,
      error: s.error,
    })),
    peerUrl: row.peerUrl ?? "",
    // A key the operator chose is never printed, so it is not handed out here either.
    setupPath:
      state === "cancelled" &&
      !process.env.DEPLO_SETUP_KEY?.trim() &&
      (await isSetupNeeded())
        ? `/setup?key=${encodeURIComponent(setupKey())}`
        : null,
    rowsCopied: row.rowsCopied,
    unreadable: row.unreadable,
    startedBy: row.startedBy,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    canRetry: !running && state === "failed",
    canCancel:
      !running &&
      (state === "connected" || state === "failed") &&
      !servers.some((s) => s.state === "handed_over"),
    canFinishWithoutSource:
      !running && state === "failed" && row.rowsCopied > 0,
  };
}

export async function currentTargetMove(): Promise<string | null> {
  await requireInstanceAdmin();
  return (await openTargetMove())?.id ?? null;
}
