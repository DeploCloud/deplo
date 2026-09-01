import "server-only";

// https://deplo.build/docs/guides/migrate/take-over-your-vps

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
  removing: ["removed", "done"],
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
 * Stamp that something other than the installer has reached the panel. Called
 * from the pages a browser lands on; the installer polls for it to find out
 * whether its port is reachable at all.
 */
export async function noteExternalRequest(
  remote: string | null,
): Promise<void> {
  if (!remote || isLoopback(remote)) return;
  const t = await takeoverStatus();
  if (!t || t.seenExternalRequest) return;
  await writeState({ takeoverSeenExternalAt: nowIso() });
}

function isLoopback(addr: string): boolean {
  const a = addr.trim().toLowerCase().split(",")[0].trim();
  return a === "::1" || a === "127.0.0.1" || a.startsWith("127.");
}

/** The operator asked for the ports. The installer takes it from here. */
export async function requestTakeover(runId: string): Promise<TakeoverStatus> {
  await requireInstanceAdmin();
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

  const outcome = current.runId
    ? await restartSourceServices(current.runId, apiKey)
    : { restarted: 0, left: [] as string[] };
  await advance("cancelled");
  return outcome;
}

/**
 * Start again exactly what the data phase stopped over there - `stoppedAt` is
 * written only by a stop that happened, so a service the operator had already
 * taken down themselves is left alone.
 */
async function restartSourceServices(
  runId: string,
  apiKey?: string,
): Promise<{ restarted: number; left: string[] }> {
  const [run] = await getDb()
    .select({
      sourceUrl: runsTable.sourceUrl,
      platform: runsTable.platform,
      apiKeyEnc: runsTable.apiKeyEnc,
      allowPrivate: runsTable.allowPrivate,
    })
    .from(runsTable)
    .where(eq(runsTable.id, runId));
  if (!run) return { restarted: 0, left: [] };

  const key = run.apiKeyEnc
    ? decryptSecretOrThrow(run.apiKeyEnc, "the panel's API token")
    : (apiKey ?? "");
  if (!isMigrationPlatform(run.platform) || !key)
    return { restarted: 0, left: ["no API token to sign in with"] };

  const stopped = await getDb()
    .select({
      serviceId: targetsTable.serviceId,
      kind: targetsTable.stoppedKind,
      name: targetsTable.projectName,
    })
    .from(targetsTable)
    .where(
      and(eq(targetsTable.runId, runId), isNotNull(targetsTable.stoppedAt)),
    );

  const client = sourceClient({
    kind: run.platform,
    baseUrl: run.sourceUrl,
    apiKey: key,
  });
  let restarted = 0;
  const left: string[] = [];
  for (const t of stopped) {
    try {
      await client.startService(t.kind ?? "application", t.serviceId);
      restarted++;
    } catch (e) {
      left.push(
        `${t.name}: ${e instanceof Error ? e.message : "would not start"}`,
      );
    }
  }
  return { restarted, left };
}
