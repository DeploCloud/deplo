import "server-only";

// https://deplo.build/docs/guides/take-over-your-vps

import { cache } from "react";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
  instanceSettings,
  migrationRuns as runsTable,
  migrationRunItems as itemsTable,
  migrationRunTargets as targetsTable,
} from "../db/schema/control-plane";
import { decryptSecretOrThrow } from "../crypto";
import { nowIso } from "../ids";
import { requireInstanceAdmin } from "../membership";
import { isMigrationPlatform, sourceClient } from "../migration/source";
import type { MigrationPlatform } from "../migration/source";

/**
 * Deplo installed onto a machine another platform already owns. The installer is
 * the only thing that can see that platform, so it seeds this state and later
 * reads it back to finish the job on the host.
 */

const SETTINGS_ID = "default";

/**
 * `pending` the wizard has not finished · `ready` the operator asked for the
 * machine · `failed` the cutover rolled back and can be asked for again · `done`
 * the ports are Deplo's · `removing` / `removed` the old platform · `cancelled`
 * the operator backed out and Deplo uninstalls itself.
 */
export const TAKEOVER_STATES = [
  "pending",
  "ready",
  "failed",
  "done",
  "removing",
  "removed",
  "cancelled",
] as const;
export type TakeoverState = (typeof TAKEOVER_STATES)[number];

/** What may follow what. Nothing ever moves backwards, except a rollback. */
const NEXT: Record<TakeoverState, readonly TakeoverState[]> = {
  pending: ["ready", "cancelled"],
  ready: ["done", "failed", "cancelled"],
  failed: ["ready", "cancelled"],
  done: ["removing"],
  removing: ["removed"],
  removed: [],
  cancelled: [],
};

export interface TakeoverStatus {
  platform: MigrationPlatform;
  state: TakeoverState;
  runId: string | null;
  /** Whether anything but the installer has ever reached this panel. */
  seenExternalRequest: boolean;
  /** Why the last cutover rolled back, in the installer's words. */
  error: string | null;
}

function isTakeoverState(v: unknown): v is TakeoverState {
  return (
    typeof v === "string" && (TAKEOVER_STATES as readonly string[]).includes(v)
  );
}

/**
 * The takeover this instance is in the middle of, or null on an ordinary install.
 * Ungated on purpose: it gates the dashboard itself, so it is read before anyone
 * is signed in, and it says nothing but which platform is being replaced.
 */
export const takeoverStatus = cache(
  async (): Promise<TakeoverStatus | null> => {
    const [row] = await getDb()
      .select({
        platform: instanceSettings.takeoverPlatform,
        state: instanceSettings.takeoverState,
        runId: instanceSettings.takeoverRunId,
        seenAt: instanceSettings.takeoverSeenExternalAt,
        error: instanceSettings.takeoverError,
      })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, SETTINGS_ID));
    if (!row || !isMigrationPlatform(row.platform)) return null;
    if (!isTakeoverState(row.state)) return null;
    return {
      platform: row.platform,
      state: row.state,
      runId: row.runId,
      seenExternalRequest: Boolean(row.seenAt),
      error: row.error,
    };
  },
);

/**
 * True while the dashboard must give way to the takeover screen - which is until
 * the old platform is off the machine. Landing on the dashboard is the moment
 * this is Deplo and nothing else, so nothing half-done is behind it.
 */
export async function takeoverBlocksDashboard(): Promise<boolean> {
  const t = await takeoverStatus();
  return t != null && t.state !== "removed" && t.state !== "cancelled";
}

async function writeState(
  patch: Partial<{
    takeoverPlatform: string;
    takeoverState: TakeoverState;
    takeoverRunId: string | null;
    takeoverSeenExternalAt: string;
    takeoverError: string | null;
  }>,
): Promise<void> {
  const now = nowIso();
  await getDb()
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, ...patch, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { ...patch, updatedAt: now },
    });
}

/**
 * Seed the state from the installer's `DEPLO_TAKEOVER` the first time this
 * instance boots. Never overwrites a state already reached - a restart mid-run
 * must not send the operator back to the beginning.
 */
export async function ensureTakeoverFromEnv(): Promise<void> {
  const platform = process.env.DEPLO_TAKEOVER?.trim().toLowerCase();
  if (!isMigrationPlatform(platform)) return;
  const current = await takeoverStatus();
  if (current) return;
  await writeState({ takeoverPlatform: platform, takeoverState: "pending" });
}

/** Move the state on, refusing anything the ladder does not allow. */
async function advance(
  to: TakeoverState,
  opts: { runId?: string; error?: string } = {},
) {
  const current = await takeoverStatus();
  if (!current) throw new Error("This instance is not taking over a machine.");
  if (current.state === to) return current;
  if (!NEXT[current.state].includes(to))
    throw new Error(
      current.state === "removed" || current.state === "cancelled"
        ? "This takeover is already over."
        : "The takeover has already moved on. Reload the page to see where it is.",
    );
  // The reason lives exactly as long as the failure it explains.
  const error = to === "failed" ? (opts.error ?? "") : null;
  await writeState({
    takeoverState: to,
    takeoverError: error,
    ...(opts.runId ? { takeoverRunId: opts.runId } : {}),
  });
  return { ...current, state: to, runId: opts.runId ?? current.runId, error };
}

/**
 * Stamp that a BROWSER has reached the panel. Called from the two pages one can
 * land on; the installer only ever calls `/api/takeover`, so rendering either of
 * them is the signal - and a remote address is not available to a server
 * component anyway.
 */
export async function noteBrowserReached(): Promise<void> {
  const t = await takeoverStatus();
  if (!t || t.seenExternalRequest) return;
  await writeState({ takeoverSeenExternalAt: nowIso() });
}

/**
 * The operator asked for the machine: the installer moves the ports and then
 * takes the other platform off the disk, in one go.
 *
 * Either a run that finished, or `discardData` - the operator has chosen to keep
 * nothing. Without one of the two, taking the ports would cost them their old
 * panel's routing for nothing, and a disabled button is not a gate.
 */
/**
 * The services of a run that arrived WITHOUT their data - a copy that failed -
 * named the way the report names them. The cutover removes the old panel's
 * volumes, so for these the old panel holds the only copy there is.
 */
export async function takeoverDataLoss(runId: string): Promise<string[]> {
  // The report is history; the marker on the resource is the state, and a copy
  // run again clears it. So: every service the run landed on that is STILL marked.
  const rows = await getDb()
    .select({
      name: itemsTable.sourceName,
      kind: itemsTable.targetKind,
      target: itemsTable.targetId,
    })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.runId, runId),
        inArray(itemsTable.targetKind, ["app", "database"]),
        inArray(itemsTable.outcome, ["created", "skipped", "failed"]),
      ),
    );
  const ids = (kind: string) => [
    ...new Set(
      rows.filter((r) => r.kind === kind && r.target).map((r) => r.target!),
    ),
  ];
  const marked = new Set<string>();
  const appIds = ids("app");
  if (appIds.length > 0)
    for (const a of await getDb()
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(
        and(inArray(appsTable.id, appIds), ne(appsTable.dataCopyError, "")),
      ))
      marked.add(a.id);
  const dbIds = ids("database");
  if (dbIds.length > 0)
    for (const d of await getDb()
      .select({ id: databasesTable.id })
      .from(databasesTable)
      .where(
        and(
          inArray(databasesTable.id, dbIds),
          ne(databasesTable.dataCopyError, ""),
        ),
      ))
      marked.add(d.id);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of rows) {
    if (!r.target || !marked.has(r.target) || seen.has(r.target)) continue;
    seen.add(r.target);
    names.push(r.name);
  }
  return names;
}

/** A migration still moving, in ANY team: the machine is one, the runs are per team. */
async function migrationInFlight(): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(eq(runsTable.status, "running"))
    .limit(1);
  return Boolean(row);
}

export async function requestTakeover(
  runId: string | null,
  opts: {
    noOtherTeams?: boolean;
    discardData?: boolean;
    acceptDataLoss?: boolean;
  } = {},
): Promise<TakeoverStatus> {
  await requireInstanceAdmin();
  // The cutover stops every container of the old panel: under a copy still in
  // flight that is data half way across and a source that never comes back.
  if (await migrationInFlight())
    throw new Error(
      "A migration is still running. Wait for it to finish, or stop it, before taking the machine.",
    );
  // Nothing is being brought across, so there is no run to check. The wizard's
  // typed confirmation is what says this on purpose; this is the only door in.
  if (opts.discardData) return advance("ready");
  if (!runId)
    throw new Error(
      "That migration does not exist, so there is nothing to take the ports for.",
    );
  const [run] = await getDb()
    .select({ status: runsTable.status, keepSources: runsTable.keepSources })
    .from(runsTable)
    .where(eq(runsTable.id, runId));
  if (!run)
    throw new Error(
      "That migration does not exist, so there is nothing to take the ports for.",
    );
  if (run.status !== "done")
    throw new Error(
      `That migration is ${run.status}. Let it finish before handing Deplo the ports.`,
    );
  // The cutover stops that panel and its containers for good, and nothing here
  // can start them again. A run that says another team is still owed is the one
  // fact Deplo has about it, and the operator has to overrule it on purpose.
  if (run.keepSources && !opts.noOtherTeams)
    throw new Error(
      "That migration still has teams to bring over from the panel. Finish them first: taking the ports stops it for good, and a token reads one team.",
    );
  // A copy that failed leaves the old panel holding the only data there is, and
  // the cutover deletes it. Never on a default: the operator says so by name.
  const lost = await takeoverDataLoss(runId);
  if (lost.length > 0 && !opts.acceptDataLoss)
    throw new Error(
      `${lost.length} ${lost.length === 1 ? "service" : "services"} arrived without ${lost.length === 1 ? "its" : "their"} data (${lost.join(", ")}). Taking over deletes the old panel's copy, so copy the data again first, or confirm that it may be lost.`,
    );
  return advance("ready", { runId });
}

/**
 * The installer reporting in. Ungated because it arrives with the host bootstrap
 * token rather than a session. `failed` is the one step back: the ports were put
 * back where they were, and the reason is what the wizard shows next to Try again.
 */
export async function markTakeoverProgress(
  to: "done" | "removing" | "removed" | "failed",
  error?: string,
): Promise<TakeoverStatus> {
  return advance(to, { error });
}

/**
 * Back out: stop the run, undo what it created, and start the source's services
 * again over there. The installer sees `cancelled` and uninstalls Deplo.
 *
 * The API token is wiped when a run stops, so a cancel after the fact has to be
 * handed one again - the operator minted it minutes ago and still has it.
 */
export async function cancelTakeover(
  apiKey?: string,
): Promise<{ restarted: number; left: string[] }> {
  await requireInstanceAdmin();
  const current = await takeoverStatus();
  if (!current) throw new Error("This instance is not taking over a machine.");
  if (
    current.state !== "pending" &&
    current.state !== "ready" &&
    current.state !== "failed"
  )
    throw new Error(
      "The ports are already Deplo's, so there is nothing to hand back.",
    );
  // Backing out starts the panel's services again - under a copy still reading
  // one of them that is a tar of a live volume reported as "Copied".
  if (await migrationInFlight())
    throw new Error(
      "A migration is still running. Stop it first, then cancel the takeover.",
    );

  const outcome = await restartStoppedSources(apiKey);
  await advance("cancelled");
  return outcome;
}

/**
 * Start again exactly what this Deplo stopped over there. Driven by `stoppedAt`
 * rather than by a run id: a stop that happened is the only thing to undo, and
 * the operator can back out long before a run id has been written anywhere.
 * A service they had stopped themselves carries no stamp and is left alone.
 */
async function restartStoppedSources(
  apiKey?: string,
): Promise<{ restarted: number; left: string[] }> {
  const stopped = await getDb()
    .select({
      runId: targetsTable.runId,
      serviceId: targetsTable.serviceId,
      kind: targetsTable.stoppedKind,
      name: targetsTable.projectName,
      sourceUrl: runsTable.sourceUrl,
      platform: runsTable.platform,
      apiKeyEnc: runsTable.apiKeyEnc,
    })
    .from(targetsTable)
    .innerJoin(runsTable, eq(runsTable.id, targetsTable.runId))
    .where(isNotNull(targetsTable.stoppedAt));

  let restarted = 0;
  const left: string[] = [];
  for (const t of stopped) {
    // The token is wiped when a run ends, so most of these need the one the
    // operator hands over again.
    const key = t.apiKeyEnc
      ? decryptSecretOrThrow(t.apiKeyEnc, "the panel's API token")
      : (apiKey ?? "");
    if (!isMigrationPlatform(t.platform) || !key) {
      left.push(`${t.name}: no API token to sign in with`);
      continue;
    }
    try {
      await sourceClient({
        kind: t.platform,
        baseUrl: t.sourceUrl,
        apiKey: key,
      }).startService(t.kind ?? "application", t.serviceId);
      restarted++;
    } catch (e) {
      left.push(
        `${t.name}: ${e instanceof Error ? e.message : "would not start"}`,
      );
    }
  }
  return { restarted, left };
}

/* ------------------------------------------------------------------ */
/* What this machine can actually take                                 */
/* ------------------------------------------------------------------ */

export interface TakeoverPreflight {
  diskFreeBytes: number;
  diskTotalBytes: number;
  /**
   * The copy writes a second copy of every volume it moves, and nothing here can
   * measure what they hold - so this is a warning with the real numbers, never a
   * refusal over an amount nobody knows.
   *
   * ponytail: a `VolumeSize` RPC would turn this into a real comparison; it needs
   * an agent release, and the free space is the number that actually goes wrong.
   */
  diskTight: boolean;
  /** Whether the agent on this machine ANSWERS - a live probe, not a stored row. */
  agentReady: boolean;
  agentMessage: string;
}

/** Under either of these, a volume copy on this machine is a gamble. */
const DISK_FLOOR_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_FLOOR_RATIO = 0.1;

/**
 * What a takeover of THIS machine is walking into. Both halves are things that
 * only show up mid-copy otherwise: a disk with no room for a second copy, and an
 * agent the control plane cannot dial.
 */
export async function takeoverPreflight(): Promise<TakeoverPreflight | null> {
  await requireInstanceAdmin();
  const { deploHostServer } = await import("./instance-settings");
  const host = await deploHostServer();
  if (!host) return null;

  const { checkServerHealth } = await import("./server-health");
  const { fetchHostInfo } = await import("../infra/agent-client");

  let agentReady = false;
  let agentMessage = "";
  try {
    const probed = await checkServerHealth(host.id, { force: true });
    agentReady = probed.status === "online";
    agentMessage = probed.statusMessage || "";
  } catch (e) {
    agentMessage = e instanceof Error ? e.message : "the agent did not answer";
  }

  let diskTotalBytes = 0;
  let diskFreeBytes = 0;
  if (agentReady) {
    try {
      const info = await fetchHostInfo(host.id);
      diskTotalBytes = info.diskTotalBytes;
      diskFreeBytes = Math.max(0, info.diskTotalBytes - info.diskUsedBytes);
    } catch {
      /* the host answered Hello but not this; the disk line simply reads 0 */
    }
  }

  return {
    diskFreeBytes,
    diskTotalBytes,
    diskTight:
      diskTotalBytes > 0 &&
      (diskFreeBytes < DISK_FLOOR_BYTES ||
        diskFreeBytes / diskTotalBytes < DISK_FLOOR_RATIO),
    agentReady,
    agentMessage,
  };
}
