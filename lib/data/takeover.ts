import "server-only";

// https://deplo.build/docs/migrations

import { cache } from "@/lib/request-cache";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { instanceSettings } from "../db/schema/control-plane/instance";
import {
  migrationRuns as runsTable,
  migrationRunItems as itemsTable,
  migrationRunTargets as targetsTable,
} from "../db/schema/control-plane/migration";
import { decryptSecretOrThrow } from "../crypto";
import { nowIso } from "../ids";
import { requireInstanceAdmin } from "../membership";
import { isMigrationPlatform, sourceClient } from "../migration/source";
import type { MigrationPlatform } from "../migration/source";

const SETTINGS_ID = "default";

// TAKEOVER_STATES - the ladder the takeover walks, from pending to removed.
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

// Never backwards except a rollback; a later host state is taken from ready and done too.
const NEXT: Record<TakeoverState, readonly TakeoverState[]> = {
  pending: ["ready", "cancelled"],
  ready: ["done", "removing", "removed", "failed", "cancelled"],
  failed: ["ready", "cancelled"],
  done: ["removing", "removed"],
  removing: ["removed"],
  removed: [],
  cancelled: [],
};

export interface TakeoverStatus {
  platform: MigrationPlatform;
  state: TakeoverState;
  runId: string | null;
  seenExternalRequest: boolean;
  error: string | null;
}

function isTakeoverState(v: unknown): v is TakeoverState {
  return (
    typeof v === "string" && (TAKEOVER_STATES as readonly string[]).includes(v)
  );
}

// takeoverStatus - the takeover in progress, or null; ungated because it gates the dashboard itself.
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

// takeoverAwaitsCutover - true while the ports are still the old panel's, so addresses must name it.
export async function takeoverAwaitsCutover(): Promise<boolean> {
  const t = await takeoverStatus();
  return (
    t != null &&
    (t.state === "pending" || t.state === "ready" || t.state === "failed")
  );
}

// takeoverBlocksDashboard - true until the old platform is off the machine.
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

// ensureTakeoverFromEnv - seed from DEPLO_TAKEOVER at boot, never over a state already reached.
export async function ensureTakeoverFromEnv(): Promise<void> {
  const platform = process.env.DEPLO_TAKEOVER?.trim().toLowerCase();
  if (!isMigrationPlatform(platform)) return;
  const current = await takeoverStatus();
  if (current) return;
  await writeState({ takeoverPlatform: platform, takeoverState: "pending" });
}

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
  const error = to === "failed" ? (opts.error ?? "") : null;
  await writeState({
    takeoverState: to,
    takeoverError: error,
    ...(opts.runId ? { takeoverRunId: opts.runId } : {}),
  });
  return { ...current, state: to, runId: opts.runId ?? current.runId, error };
}

// noteBrowserReached - stamp that a BROWSER reached the panel; the installer only calls /api/takeover.
export async function noteBrowserReached(): Promise<void> {
  const t = await takeoverStatus();
  if (!t || t.seenExternalRequest) return;
  await writeState({ takeoverSeenExternalAt: nowIso() });
}

// takeoverDataLoss - the services that arrived WITHOUT their data, named as the report names them.
export async function takeoverDataLoss(runId?: string): Promise<string[]> {
  // The marker on the resource is the state, not the report: a copy run again clears it.
  const runs = runId
    ? [runId]
    : (
        await getDb()
          .select({ id: runsTable.id })
          .from(runsTable)
          .where(eq(runsTable.status, "done"))
      ).map((r) => r.id);
  if (runs.length === 0) return [];
  const rows = await getDb()
    .select({
      name: itemsTable.sourceName,
      kind: itemsTable.targetKind,
      target: itemsTable.targetId,
    })
    .from(itemsTable)
    .where(
      and(
        inArray(itemsTable.runId, runs),
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

// Any team: the machine is one, the runs are per team.
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
  // The cutover stops the old panel for good: a copy in flight is data half way across.
  if (await migrationInFlight())
    throw new Error(
      "A migration is still running. Wait for it to finish, or stop it, before taking the machine.",
    );
  // Nothing is coming across, so there is no run to check; the typed confirmation is the gate.
  if (opts.discardData) return advance("ready");
  if (!runId)
    throw new Error(
      "That migration does not exist, so there is nothing to take the ports for.",
    );
  const [run] = await getDb()
    .select({
      status: runsTable.status,
      keepSources: runsTable.keepSources,
      sessionId: runsTable.sessionId,
    })
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
  // The cutover stops that panel for good, so a run still owing a team is overruled by hand.
  const owed = run.sessionId
    ? (
        await getDb()
          .select({ id: runsTable.id })
          .from(runsTable)
          .where(
            and(
              eq(runsTable.sessionId, run.sessionId),
              inArray(runsTable.status, ["queued", "running"]),
            ),
          )
          .limit(1)
      ).length > 0
    : run.keepSources;
  if (owed && !opts.noOtherTeams)
    throw new Error(
      "That migration still has teams to bring over from the panel. Finish them first: taking the ports stops it for good, and a token reads one team.",
    );
  // A failed copy leaves the old panel holding the only data, and the cutover stops it for good.
  const lost = await takeoverDataLoss();
  if (lost.length > 0 && !opts.acceptDataLoss)
    throw new Error(
      `${lost.length} ${lost.length === 1 ? "service" : "services"} arrived without ${lost.length === 1 ? "its" : "their"} data (${lost.join(", ")}). Taking over stops the old panel for good - its volumes stay on the disk, but nothing reads them - so copy the data again first, or confirm that it may be lost.`,
    );
  return advance("ready", { runId });
}

// markTakeoverProgress - the installer reporting in; ungated because it carries the bootstrap token.
export async function markTakeoverProgress(
  to: "done" | "removing" | "removed" | "failed",
  error?: string,
): Promise<TakeoverStatus> {
  return advance(to, { error });
}

// cancelTakeover - stop, undo, restart the source's services; the API token has to be handed back.
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
  // Backing out restarts the panel's services: a copy still reading one would tar a live volume.
  if (await migrationInFlight())
    throw new Error(
      "A migration is still running. Stop it first, then cancel the takeover.",
    );

  const outcome = await restartStoppedSources(apiKey);
  await advance("cancelled");
  return outcome;
}

// Driven by stoppedAt, not a run id: a service the operator stopped themselves carries no stamp.
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
    // The token is wiped when a run ends, so most of these need the operator's again.
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

export interface TakeoverPreflight {
  diskFreeBytes: number;
  diskTotalBytes: number;
  // ponytail: a `VolumeSize` RPC would make this a real comparison; it needs an
  // agent release, and the free space is the number that actually goes wrong.
  diskTight: boolean;
  agentReady: boolean;
  agentMessage: string;
}

const DISK_FLOOR_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_FLOOR_RATIO = 0.1;

// takeoverPreflight - what a takeover of THIS machine walks into: disk room and a live agent.
export async function takeoverPreflight(): Promise<TakeoverPreflight | null> {
  await requireInstanceAdmin();
  const { deploHostServer } =
    await import("./instance-settings/settings-store");
  const host = await deploHostServer();
  if (!host) return null;

  const { checkServerHealth } = await import("./server-health");
  const { fetchHostInfo } = await import("../infra/agent-client/host-ops");

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
