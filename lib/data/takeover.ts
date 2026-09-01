import "server-only";

// https://deplo.build/docs/guides/take-over-your-vps

import { cache } from "react";
import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  instanceSettings,
  migrationRuns as runsTable,
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
 * ports · `done` they are Deplo's · `removing` / `removed` the old platform ·
 * `cancelled` the operator backed out and the installer is uninstalling Deplo.
 */
export const TAKEOVER_STATES = [
  "pending",
  "ready",
  "done",
  "removing",
  "removed",
  "cancelled",
] as const;
export type TakeoverState = (typeof TAKEOVER_STATES)[number];

/** What may follow what. Nothing ever moves backwards. */
const NEXT: Record<TakeoverState, readonly TakeoverState[]> = {
  pending: ["ready", "cancelled"],
  ready: ["done", "cancelled"],
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
    };
  },
);

/** True while the dashboard must give way to the takeover screen. */
export async function takeoverBlocksDashboard(): Promise<boolean> {
  const t = await takeoverStatus();
  return t?.state === "pending" || t?.state === "ready";
}

async function writeState(
  patch: Partial<{
    takeoverPlatform: string;
    takeoverState: TakeoverState;
    takeoverRunId: string | null;
    takeoverSeenExternalAt: string;
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
async function advance(to: TakeoverState, opts: { runId?: string } = {}) {
  const current = await takeoverStatus();
  if (!current) throw new Error("This instance is not taking over a machine.");
  if (current.state === to) return current;
  if (!NEXT[current.state].includes(to))
    throw new Error(`A takeover at "${current.state}" cannot move to "${to}".`);
  await writeState({
    takeoverState: to,
    ...(opts.runId ? { takeoverRunId: opts.runId } : {}),
  });
  return { ...current, state: to, runId: opts.runId ?? current.runId };
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
 * The operator asked for the ports. The installer takes it from here.
 *
 * A run that finished is the point of the whole thing: taking the ports with
 * nothing brought across costs the operator their old panel's routing for
 * nothing, and the button being disabled is not a gate.
 */
export async function requestTakeover(runId: string): Promise<TakeoverStatus> {
  await requireInstanceAdmin();
  const [run] = await getDb()
    .select({ status: runsTable.status })
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
  return advance("ready", { runId });
}

/** The operator asked for the old platform to go. The installer does the removal. */
export async function requestPlatformRemoval(): Promise<TakeoverStatus> {
  await requireInstanceAdmin();
  return advance("removing");
}

/**
 * The installer reporting in. Ungated because it arrives with the host bootstrap
 * token rather than a session, and it can only ever move the state forward.
 */
export async function markTakeoverProgress(
  to: "done" | "removed",
): Promise<TakeoverStatus> {
  return advance(to);
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
  if (current.state !== "pending" && current.state !== "ready")
    throw new Error(
      "The ports are already Deplo's, so there is nothing to hand back.",
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
