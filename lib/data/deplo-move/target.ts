import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { getCurrentUser } from "../../auth/current-user";
import { isSetupNeeded, logSetupLink, setupKey } from "../../auth/setup";
import { encryptSecret, randomToken } from "../../crypto";
import { getDb } from "../../db/client";
import journal from "../../db/migrations/meta/_journal.json";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  deploMoves,
  deploMoveServers,
  deploMoveWorkloads,
} from "../../db/schema/control-plane/deplo-move";
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
  type MoveServerSummary,
  type MoveWorkloadState,
  type TargetMoveState,
  type WorkloadKind,
} from "../../deplo-move/protocol";
import { databaseClashes } from "../../deplo-move/database-clash";
import { schemaTag } from "../../deplo-move/schema-tag";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import { canonicalHost } from "../../host-address";
import { removeUploads } from "../../deploy/upload";
import { recordActivity } from "../activity";
import { nowIso } from "../../ids";
import { isInstanceAdmin, requireInstanceAdmin } from "../../membership";
import { instanceFingerprint } from "../../migration/deplo/instance";
import { publicBaseUrl } from "../../public-url";
import type { Server } from "../../types/server";
import { canHostWorkloads, listAllServers } from "../servers/roster";
import { teardownOrQueue } from "../teardown-queue";
import { wipeForMove } from "./restore";
import {
  NO_PANEL_ADDRESS,
  activeMoveRun,
  credentialOf,
  finishWithoutOldDeplo,
  launchMove,
  moveServerRows,
  moveWorkloadRows,
  setMoveState,
  stopMoveRun,
  targetMoveRow,
  type TargetMoveRow,
  type TargetMoveWorkloadRow,
} from "./runner";
import { invalidateSchedulesPaused, schedulesPaused } from "./schedules";
import { leaveOutHere } from "./workload-copy";

// The new Deplo's side of a Deplo move (ADR-0035).

// One of this Deplo's own servers, as a place an old server can land.
export interface MoveTargetServer {
  id: string;
  name: string;
  address: string;
  isThisMachine: boolean;
  canHostWorkloads: boolean;
}

export interface MovePreviewServer {
  id: string;
  name: string;
  address: string;
  port: number | null;
  role: MoveServerSummary["role"];
  isPanelHost: boolean;
  enrolled: boolean;
  reachable: boolean;
  agentVersion: string | null;
  apps: number;
  databases: number;
  // Each database's address on that server: two from different old servers cannot share one server here.
  databaseHosts: { id: string; name: string; host: string }[];
  // Where it lands here unless the map says otherwise; null for a migration source, which is never copied.
  target: string | null;
  // The servers here it may land on. Empty: it is not copied.
  choices: string[];
  // What keeps the move from starting because of this server, in one sentence.
  problem: string | null;
}

export interface TargetMovePreview {
  id: string;
  peerUrl: string;
  version: string;
  counts: MoveHello["counts"];
  servers: MovePreviewServer[];
  targets: MoveTargetServer[];
  // startMove refuses while any remains.
  problems: string[];
  warnings: string[];
  canStart: boolean;
}

export interface MoveServerMapEntry {
  from: string;
  to: string | null;
}

export type MoveStatusStepKey = "copy" | "deploy" | "finish";
export type MoveStatusStepState = "waiting" | "running" | "done" | "failed";

export interface MoveStatusServer {
  id: string;
  name: string;
  targetId: string | null;
  targetName: string | null;
}

export interface MoveStatusWorkload {
  kind: WorkloadKind;
  id: string;
  name: string;
  state: MoveWorkloadState;
  // Why it failed or was left out. Empty otherwise.
  error: string;
}

export interface MoveStatus {
  id: string;
  state: TargetMoveState;
  error: string;
  steps: { key: MoveStatusStepKey; state: MoveStatusStepState }[];
  servers: MoveStatusServer[];
  workloads: MoveStatusWorkload[];
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
  // The copy landed and the move stopped: finishing here leaves out what did not come across.
  canFinishWithoutSource: boolean;
  // A failed app or database can be left out, so the rest of the move finishes.
  canSkip: boolean;
  // The copy landed: cancelling, finishing or skipping needs an instance admin, and this viewer is not one.
  needsAdminSignIn: boolean;
}

const NO_SUCH_MOVE = "There is no such move on this Deplo.";
const ALREADY_UNDER_WAY =
  "A move into this Deplo is already under way: open it to retry or cancel it.";
const ANOTHER_RUNNING = "Another move is running on this Deplo right now.";
export const SKIPPED_BY_HAND =
  "Left out by an instance admin: deploy it and bring its data here by hand.";
export const DOMAINS_WARNING =
  "Point each app's domain at its new server when you switch: until then the old Deplo keeps serving it.";

const OPEN_STATES: TargetMoveState[] = [
  "connected",
  "copying",
  "deploying",
  "failed",
];

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

// A move only goes into a fresh install. Servers of its own are fine: the new machine is always one.
async function emptinessProblem(): Promise<string | null> {
  const db = getDb();
  const [apps, databases, teams, users] = await Promise.all([
    db.$count(appsTable),
    db.$count(databasesTable),
    db.$count(teamsTable),
    db.$count(usersTable),
  ]);
  if (apps > 0 || databases > 0)
    return "Needs an empty Deplo, and this one already has apps or databases. Bring only some teams instead.";
  if (teams > 1 || users > 1)
    return "Needs an empty Deplo, and this one already has other teams or people. Bring only some teams instead.";
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

function holdsWorkloads(s: MoveServerSummary): boolean {
  return s.apps > 0 || s.databases > 0;
}

function addressesOf(s: { ip?: string; host?: string }): string[] {
  return [canonicalHost(s.ip), canonicalHost(s.host)].filter(
    (a): a is string => !!a,
  );
}

// A server here that is also one of the old Deplo's would run both copies on one machine.
function landingServers(hello: MoveHello, here: Server[]): Server[] {
  const old = new Set(
    hello.servers.flatMap((s) =>
      addressesOf({ ip: s.address, host: s.address }),
    ),
  );
  return here.filter((h) => !addressesOf(h).some((a) => old.has(a)));
}

// Any of them may hold apps, databases or disk backups, so each lands somewhere fit; a migration source never does.
function choicesFor(s: MoveServerSummary, here: Server[]): string[] {
  const fits =
    s.role === "import"
      ? []
      : s.role === "workloads"
        ? here.filter(canHostWorkloads)
        : s.role === "build"
          ? here.filter((h) => !h.importOnly && !h.storageOnly)
          : here.filter((h) => !h.importOnly);
  return fits.map((h) => h.id);
}

const NOWHERE: Record<MoveServerSummary["role"], string> = {
  workloads: "run apps",
  build: "build apps",
  storage: "keep backups",
  import: "",
};

function defaultTarget(choices: string[], here: Server[]): string | null {
  const self = deploHostSelfAddresses();
  const thisMachine = here.find(
    (h) => choices.includes(h.id) && isDeploHostServer(h, self),
  );
  return thisMachine?.id ?? choices[0] ?? null;
}

interface Inspection {
  hello: MoveHello;
  servers: MovePreviewServer[];
  targets: MoveTargetServer[];
  // Each server's own; a database clash depends on the map, so it is added for the map at hand.
  problems: string[];
  warnings: string[];
}

function clashesFor(
  found: Inspection,
  targetOf: (oldServerId: string) => string | null | undefined,
): string[] {
  const names = new Map(found.targets.map((t) => [t.id, t.name] as const));
  return databaseClashes(
    found.servers,
    targetOf,
    (id) => names.get(id) ?? "one server here",
  );
}

async function inspect(c: moveClient.MoveCredential): Promise<Inspection> {
  const hello = await moveClient.hello(c);
  if (hello.instance === instanceFingerprint())
    throw new Error(
      "That address is this Deplo: enter the address of the Deplo you are moving from.",
    );
  if (hello.protocol !== MOVE_PROTOCOL || hello.schema !== schemaTag())
    throw new Error(
      olderSide(hello) === "old"
        ? `The old Deplo runs an older version (${hello.version}): update it, then connect again.`
        : `This Deplo is older than the old one (${hello.version}): update this Deplo, then connect again.`,
    );
  const self = deploHostSelfAddresses();
  const here = landingServers(hello, await listAllServers());
  const servers = hello.servers.map((s): MovePreviewServer => {
    const choices = choicesFor(s, here);
    let problem: string | null = null;
    if (isDeploHostServer({ ip: s.address, host: s.address }, self))
      problem = `${s.name} is this machine: install the new Deplo on a machine the old one does not use.`;
    else if (choices.length === 0 && s.role !== "import")
      problem = `No server here can ${NOWHERE[s.role]} in place of ${s.name}: add one under Servers, then check again.`;
    return {
      id: s.id,
      name: s.name,
      address: s.address,
      port: s.port,
      role: s.role,
      isPanelHost: s.isPanelHost,
      enrolled: s.enrolled,
      reachable: s.reachable,
      agentVersion: s.agentVersion,
      apps: s.apps,
      databases: s.databases,
      databaseHosts: (s.databaseHosts ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        host: d.host,
      })),
      target: defaultTarget(choices, here),
      choices,
      problem,
    };
  });
  const unreachable = servers.filter(
    (s) => !s.problem && !s.reachable && s.enrolled && holdsWorkloads(s),
  );
  return {
    hello,
    servers,
    targets: here.map((h) => ({
      id: h.id,
      name: h.name,
      address: h.ip || h.host,
      isThisMachine: isDeploHostServer(h, self),
      canHostWorkloads: canHostWorkloads(h),
    })),
    problems: servers.flatMap((s) => (s.problem ? [s.problem] : [])),
    warnings: [
      ...(hello.counts.apps > 0 ? [DOMAINS_WARNING] : []),
      ...addressWarning(hello.panelUrl),
      ...unreachable.map(
        (s) =>
          `The old Deplo cannot reach ${s.name} right now, so its data cannot be copied until it is back.`,
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
  const problems = [
    ...found.problems,
    ...clashesFor(
      found,
      (from) => found.servers.find((s) => s.id === from)?.target,
    ),
  ];
  return {
    id,
    peerUrl: baseUrl,
    version: found.hello.version,
    counts: found.hello.counts,
    servers: found.servers,
    targets: found.targets,
    problems,
    warnings: found.warnings,
    canStart: problems.length === 0,
  };
}

// Every old server once, in the old Deplo's order: an entry left out takes its default.
function resolveMap(
  found: Inspection,
  map: MoveServerMapEntry[],
): { serverId: string; targetServerId: string | null; name: string }[] {
  const given = new Map<string, string | null>();
  for (const e of map) {
    if (!found.servers.some((s) => s.id === e.from))
      throw new Error(
        "The server map names a server the old Deplo does not have.",
      );
    given.set(e.from, e.to?.trim() || null);
  }
  return found.servers.map((s) => {
    if (s.role === "import")
      return { serverId: s.id, targetServerId: null, name: s.name };
    const to = given.has(s.id) ? given.get(s.id)! : s.target;
    if (!to || !s.choices.includes(to))
      throw new Error(
        s.role === "workloads" && holdsWorkloads(s)
          ? `${s.name} holds apps or databases, so it needs a server here that runs apps.`
          : `${s.name} needs a server here that can ${NOWHERE[s.role]}.`,
      );
    return { serverId: s.id, targetServerId: to, name: s.name };
  });
}

export async function startMove(
  id: string,
  map: MoveServerMapEntry[] = [],
): Promise<MoveStatus> {
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
  const entries = resolveMap(found, map);
  const lands = new Map(entries.map((e) => [e.serverId, e.targetServerId]));
  const [clash] = clashesFor(found, (from) => lands.get(from));
  if (clash) throw new Error(clash);
  const startedBy = await starterName();
  const now = nowIso();
  await getDb().transaction(async (tx) => {
    await tx.delete(deploMoveServers).where(eq(deploMoveServers.moveId, id));
    if (entries.length)
      await tx.insert(deploMoveServers).values(
        entries.map((e, position) => ({
          moveId: id,
          ...e,
          position,
          updatedAt: now,
        })),
      );
  });
  await setMoveState(id, "copying", { error: "", startedBy });
  launchMove(id);
  return (await moveStatus(id))!;
}

function copyCommitted(row: TargetMoveRow): boolean {
  return row.rowsCopied > 0;
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
  const committed = copyCommitted(row);
  if (committed)
    await getDb()
      .update(deploMoveWorkloads)
      .set({ state: "waiting", error: "", updatedAt: nowIso() })
      .where(
        and(
          eq(deploMoveWorkloads.moveId, id),
          inArray(deploMoveWorkloads.state, ["failed", "copying"]),
        ),
      );
  await setMoveState(id, committed ? "deploying" : "copying", { error: "" });
  launchMove(id);
  return (await moveStatus(id))!;
}

// Every workload goes, whatever its row says: a retry resets one to waiting after it was deployed here.
async function tearDownDeployed(
  workloads: TargetMoveWorkloadRow[],
): Promise<() => Promise<void>> {
  const appIds = workloads
    .filter((w) => w.kind === "app")
    .map((w) => w.workloadId);
  const dbIds = workloads
    .filter((w) => w.kind === "database")
    .map((w) => w.workloadId);
  const db = getDb();
  const [apps, dbs] = await Promise.all([
    appIds.length
      ? db
          .select({
            id: appsTable.id,
            name: appsTable.name,
            serverId: appsTable.serverId,
            key: appsTable.slug,
          })
          .from(appsTable)
          .where(inArray(appsTable.id, appIds))
      : [],
    dbIds.length
      ? db
          .select({
            id: databasesTable.id,
            name: databasesTable.name,
            serverId: databasesTable.serverId,
            key: databasesTable.host,
          })
          .from(databasesTable)
          .where(inArray(databasesTable.id, dbIds))
      : [],
  ]);
  // Queued after the wipe: an entry names no team, so the wipe neither drops it nor points it at one.
  return async () => {
    for (const s of [...apps, ...dbs])
      await teardownOrQueue({
        serverId: s.serverId,
        deployKey: s.key,
        projectLabel: s.id,
        label: s.name,
        teamId: null,
      }).catch((e) =>
        console.error(`[deplo-move] could not remove ${s.name} here:`, e),
      );
    for (const id of appIds) await removeUploads(id);
  };
}

// Once the copy lands, the old Deplo's people may already work here: only one of its instance admins wipes it.
async function requireAdminOnceCopied(row: TargetMoveRow): Promise<void> {
  const copied =
    copyCommitted(row) ||
    (row.state !== "connected" && (await emptinessProblem()) !== null);
  if (copied) await requireInstanceAdmin();
}

// Any time before the move is done: the old Deplo starts what it paused, this one goes back to setup.
export async function cancelMove(id: string): Promise<MoveStatus> {
  let row = await targetMoveRow(id);
  if (!row) throw new Error(NO_SUCH_MOVE);
  if (row.state === "cancelled") return (await moveStatus(id))!;
  if (row.state === "done")
    throw new Error(
      "This move has finished, so it can no longer be cancelled.",
    );
  await requireAdminOnceCopied(row);
  const running = activeMoveRun();
  if (running && running !== id) throw new Error(ANOTHER_RUNNING);
  if (running) {
    await stopMoveRun(id);
    row = (await targetMoveRow(id))!;
    await requireAdminOnceCopied(row);
  }

  let note = "";
  try {
    await moveClient.cancel(credentialOf(row));
  } catch (e) {
    // 401: the old Deplo no longer knows the code, so there is nothing left to cancel there.
    if (!(e instanceof moveClient.MoveRefusedError && e.status === 401))
      note =
        "The old Deplo could not be told: cancel the move there too. Anything paused there starts again on its own.";
  }
  const copied =
    row.state !== "connected" &&
    (copyCommitted(row) || (await emptinessProblem()) !== null);
  if (copied) {
    const tearDown = await tearDownDeployed(await moveWorkloadRows(id));
    await getDb().transaction((tx) => wipeForMove(tx));
    await tearDown();
  }
  await setMoveState(id, "cancelled", {
    error: note,
    schedulesPaused: false,
    finishedAt: nowIso(),
  });
  invalidateSchedulesPaused();
  if (copied) await logSetupLink().catch(() => {});
  return (await moveStatus(id))!;
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

// For an old Deplo that is gone for good. Only after the copy, so only an instance admin signed in here.
export async function finishMoveWithoutSource(id: string): Promise<MoveStatus> {
  const row = await targetMoveRow(id);
  if (!row) throw new Error(NO_SUCH_MOVE);
  if (row.state === "done") throw new Error("This move has already finished.");
  if (row.state !== "failed" || !copyCommitted(row))
    throw new Error(
      "Only a move that stopped after the copy can finish without the old Deplo.",
    );
  await requireInstanceAdmin();
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

// A workload that keeps failing must not hold the rest hostage: an admin leaves it out, and the move finishes.
export async function skipMoveWorkload(
  id: string,
  kind: WorkloadKind,
  workloadId: string,
): Promise<MoveStatus> {
  await requireInstanceAdmin();
  const row = await targetMoveRow(id);
  if (!row) throw new Error(NO_SUCH_MOVE);
  if (
    !copyCommitted(row) ||
    (row.state !== "deploying" && row.state !== "failed")
  )
    throw new Error(
      "Only a move that is deploying apps here can leave one out.",
    );
  const [skipped] = await getDb()
    .update(deploMoveWorkloads)
    .set({
      state: "skipped" satisfies MoveWorkloadState,
      error: SKIPPED_BY_HAND,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(deploMoveWorkloads.moveId, id),
        eq(deploMoveWorkloads.kind, kind),
        eq(deploMoveWorkloads.workloadId, workloadId),
        eq(deploMoveWorkloads.state, "failed"),
      ),
    )
    .returning({ name: deploMoveWorkloads.name });
  if (!skipped)
    throw new Error("Only an app or database that failed can be left out.");
  const teamId = await leaveOutHere(id, { kind, id: workloadId });
  const user = await getCurrentUser();
  await recordActivity(
    kind,
    `Left ${skipped.name} out of the copy from ${row.peerUrl ?? "the old Deplo"}`,
    user?.name || user?.username || "An instance admin",
    kind === "app" ? workloadId : null,
    teamId,
    null,
    kind === "database" ? workloadId : null,
  );
  // Nothing else left to copy: the run only has to tell the old Deplo it is done.
  const open = (await moveWorkloadRows(id)).some((w) =>
    ["waiting", "copying", "failed"].includes(w.state),
  );
  if (!open && row.state === "failed" && !activeMoveRun()) {
    await setMoveState(id, "deploying", { error: "" });
    launchMove(id);
  }
  return (await moveStatus(id))!;
}

function stepsOf(
  row: TargetMoveRow,
  workloads: TargetMoveWorkloadRow[],
): MoveStatus["steps"] {
  const s = row.state as TargetMoveState;
  const committed = copyCommitted(row) || s === "deploying" || s === "done";
  const open = workloads.filter((w) =>
    ["waiting", "copying", "failed"].includes(w.state),
  );
  const broken = workloads.some(
    (w) => w.state === "failed" || w.state === "skipped",
  );
  let copy: MoveStatusStepState = "waiting";
  let deploy: MoveStatusStepState = "waiting";
  let finish: MoveStatusStepState = "waiting";
  if (s === "copying") copy = "running";
  else if (s === "deploying")
    [copy, deploy, finish] = open.length
      ? ["done", "running", "waiting"]
      : ["done", "done", "running"];
  else if (s === "done")
    [copy, deploy, finish] = ["done", broken ? "failed" : "done", "done"];
  else if (s === "failed" && !committed) copy = "failed";
  else if (s === "failed" && open.length) [copy, deploy] = ["done", "failed"];
  else if (s === "failed") [copy, deploy, finish] = ["done", "done", "failed"];
  return [
    { key: "copy", state: copy },
    { key: "deploy", state: deploy },
    { key: "finish", state: finish },
  ];
}

async function statusServers(moveId: string): Promise<MoveStatusServer[]> {
  const rows = await moveServerRows(moveId);
  const ids = rows.flatMap((r) => (r.targetServerId ? [r.targetServerId] : []));
  const names = new Map(
    (ids.length
      ? await getDb()
          .select({ id: serversTable.id, name: serversTable.name })
          .from(serversTable)
          .where(inArray(serversTable.id, ids))
      : []
    ).map((s) => [s.id, s.name] as const),
  );
  return rows.map((r) => ({
    id: r.serverId,
    name: r.name,
    targetId: r.targetServerId,
    targetName: r.targetServerId ? (names.get(r.targetServerId) ?? null) : null,
  }));
}

export async function moveStatus(id: string): Promise<MoveStatus | null> {
  const row = await targetMoveRow(id);
  if (!row) return null;
  const workloads = await moveWorkloadRows(id);
  const state = row.state as TargetMoveState;
  const running = activeMoveRun() === id;
  const open = state !== "done" && state !== "cancelled";
  // The viewer only matters once the copy landed: before it, the move page acts by its id alone.
  const adminOnly = open && copyCommitted(row);
  const admin = adminOnly && (await isInstanceAdmin());
  return {
    id: row.id,
    state,
    error: row.error,
    steps: stepsOf(row, workloads),
    servers: await statusServers(id),
    workloads: workloads.map((w) => ({
      kind: w.kind as WorkloadKind,
      id: w.workloadId,
      name: w.name,
      state: w.state as MoveWorkloadState,
      error: w.error,
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
    canCancel: open && (!adminOnly || admin),
    canFinishWithoutSource:
      !running && state === "failed" && copyCommitted(row) && admin,
    canSkip:
      admin &&
      (state === "deploying" || state === "failed") &&
      workloads.some((w) => w.state === "failed"),
    needsAdminSignIn: adminOnly && !admin,
  };
}

export async function currentTargetMove(): Promise<string | null> {
  await requireInstanceAdmin();
  return (await openTargetMove())?.id ?? null;
}

export interface MoveBannerState {
  // copying: changes are paused. deploying: apps here may restart. stopped: it failed after the copy.
  phase: "copying" | "deploying" | "stopped" | null;
  peerUrl: string;
  // The progress page, for an instance admin only: its id is the key to retry and cancel.
  progressPath: string | null;
  schedulesPaused: boolean;
  canResumeSchedules: boolean;
}

// Read by the dashboard on every page, by anyone signed in; only an admin learns the move's id.
export async function moveBanner(): Promise<MoveBannerState | null> {
  const [open, paused] = await Promise.all([
    openTargetMove(),
    schedulesPaused(),
  ]);
  const phase =
    open?.state === "copying" || open?.state === "deploying"
      ? open.state
      : open?.state === "failed" && copyCommitted(open)
        ? "stopped"
        : null;
  if (!phase && !paused) return null;
  const admin = await isInstanceAdmin();
  return {
    phase,
    peerUrl: open?.peerUrl ?? "",
    progressPath: phase && admin && open ? `/moving/${open.id}` : null,
    schedulesPaused: paused,
    canResumeSchedules: paused && admin,
  };
}
