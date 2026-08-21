import "server-only";

import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  pendingTeardowns,
  servers as serversTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { connectAgent, type AgentConnection } from "../infra/agent-client";
import { dispatchServerAlert } from "../notify/dispatch";
import { mapLimit } from "../utils";
import { recordActivity } from "./activity";

/**
 * The teardown queue: a stack that must die, kept until the host says it did.
 *
 * Deleting an App used to tear its stack down best-effort and drop the row
 * regardless, so an unreachable host kept the containers and the volumes and the
 * only trace was an Activity line asking somebody to go remove them by hand.
 * Nothing retried, nothing counted, and for a preview of a deleted app or a
 * deleted team's stacks not even a row survived that could name what is still
 * running. A row here IS the intent, and it outlives both the app row and the
 * team.
 *
 * Three rules make it safe:
 *
 *  1. **Write-ahead.** The row is inserted BEFORE the agent is dialed. A control
 *     plane killed mid-teardown does not get to run a catch block, and a team
 *     delete drops its own rows before the fan-out starts.
 *  2. **Identity, never the slug.** `apps_slug_uq` is global: a deleted slug can
 *     be taken by a new app on the same server within the hour. Every attempt
 *     asks the host what still carries the DOOMED thing's `deplo.project` label
 *     ({@link TeardownEntry.projectLabel}) - a reclaimed key answers "nothing of
 *     ours" and the row is dropped without a destructive call.
 *  3. **Verify, never trust `ok`.** The agent's DestroyStack lies in both
 *     directions: its fallback force-removes a container named `deplo-<slug>`,
 *     which matches neither a compose stack's `deplo-<slug>-<svc>-1` nor a
 *     database's `<host>`, and reports success; and once a successful teardown
 *     has swept the stack file, a later `down -v` on the missing file reports
 *     FAILURE for a host that is already clean. Only the container list decides.
 *
 * ponytail: the verdict covers containers, not volumes - no agent RPC lists
 * volumes. A stack whose containers are gone but whose named volumes survived an
 * older `down` without `-v` still reads as clean. Upgrade path: a ListVolumes
 * RPC, then check both here.
 */

/** One stack that must be destroyed on one host. */
export interface TeardownEntry {
  serverId: string;
  /** The compose project key: `<slug>`, `<slug>__pr-<n>`, or a database host. */
  deployKey: string;
  /** The `deplo.project` label of what is being destroyed - the identity check. */
  projectLabel: string;
  /** Human name for the Activity copy: by drain time the row it named is gone. */
  label: string;
  /** NULL for a deleted team, which is also "nowhere to report to". */
  teamId: string | null;
  /**
   * Volumes to reclaim BY NAME on the destroy, on top of what `down -v` finds.
   * In-memory only: it rides the INLINE attempt, which is the one that matters —
   * a stack whose host answers is torn down there and then. A row replayed from
   * `pending_teardowns` has no names (the app row is gone by then), and its
   * retry is about a host that was unreachable, not about a volume.
   */
  reclaimVolumes?: string[];
}

/**
 * Delay before attempt N+1, saturating on the last rung: 1m, 5m, 15m, 1h, 6h,
 * 24h, 24h. Short at the start (a restarting agent is back in seconds), long at
 * the end (a host down for a day is a decision somebody made).
 */
const BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  24 * 60 * 60_000,
];

/** Attempts before Deplo gives up, the inline one included. 8 spans ~4 days. */
export const MAX_TEARDOWN_ATTEMPTS = 8;

/** Rows per drain. Each can burn the 3-minute stack deadline on a dead host, so
 *  8 at 4-way concurrency bounds one drain near 6 minutes. */
const DRAIN_BATCH = 8;

/** Teardowns dialed at once, matching the bulk delete's own fan-out. */
const DRAIN_CONCURRENCY = 4;

/**
 * How long a freshly queued teardown is left alone. The caller that wrote it is
 * about to try it inline, and that call can burn the agent's 3-minute stack
 * deadline on a dead host: without this, the next tick would dial the same stack
 * again while the first attempt is still waiting. A failure moves the row onto
 * the ladder (a minute), so this delay only ever covers the inline try.
 */
const INLINE_GRACE_MS = 4 * 60_000;

/** How long a given-up teardown waits before a reachable host earns it a new
 *  ladder. Long enough that a stack failing for its OWN reasons cannot spin. */
const REOPEN_AFTER_MS = 60 * 60_000;

/** How recently the host must have been seen to count as reachable again. */
const SEEN_RECENTLY_MS = 5 * 60_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The slice of the agent a teardown touches. */
type TeardownAgent = Pick<
  AgentConnection,
  "destroyStack" | "listInstances" | "stopStack" | "close"
>;

/** The dialer, swapped in tests: the pglite harness has no agent to answer. */
let dial: (serverId: string) => Promise<TeardownAgent> = connectAgent;

export function __setTeardownDialForTest(
  fn: ((serverId: string) => Promise<TeardownAgent>) | null,
): void {
  dial = fn ?? connectAgent;
}

/**
 * What to do after a failed attempt. Pure, so the ladder is testable without a
 * host. `attempts` is the count INCLUDING the failure just recorded.
 */
export function nextTeardownAttempt(
  attempts: number,
  now: Date,
): { giveUp: true } | { giveUp: false; at: string } {
  if (attempts >= MAX_TEARDOWN_ATTEMPTS) return { giveUp: true };
  const step = BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
  return { giveUp: false, at: new Date(now.getTime() + step).toISOString() };
}

/**
 * Record the intents. One statement, `ON CONFLICT DO NOTHING`: a second enqueue
 * for the same stack must be a no-op rather than a second ladder of retries.
 * Never throws - a queue write that fails must not fail the delete the user
 * asked for (the boot drain still has the app row's own stamp to work from).
 */
export async function enqueueTeardowns(entries: TeardownEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const now = nowIso();
  const firstDrain = new Date(Date.now() + INLINE_GRACE_MS).toISOString();
  try {
    await getDb()
      .insert(pendingTeardowns)
      .values(
        entries.map((e) => ({
          id: newId("tdn"),
          serverId: e.serverId,
          deployKey: e.deployKey,
          projectLabel: e.projectLabel,
          label: e.label,
          teamId: e.teamId,
          attempts: 0,
          lastError: "",
          nextAttemptAt: firstDrain,
          abandonedAt: null,
          createdAt: now,
        })),
      )
      .onConflictDoNothing();
  } catch (e) {
    console.error("[deplo] could not queue a teardown:", errMsg(e));
  }
}

/** The containers on `conn` that belong to this exact stack, by label AND key. */
async function stackContainers(
  conn: TeardownAgent,
  entry: Pick<TeardownEntry, "deployKey" | "projectLabel">,
): Promise<string[] | null> {
  const rows = await conn
    .listInstances(entry.projectLabel, entry.deployKey, "")
    .catch(() => null);
  if (rows === null) return null;
  // The label already scopes the answer to the doomed thing, so this only has to
  // separate deploy keys that SHARE one: `blink` must not count `blink__pr-3`'s
  // containers as survivors of its own teardown. Three name shapes exist -
  // `deplo-<key>-<service>-<n>` for a compose stack, `deplo-<key>` for a single
  // image, and a BARE `<host>` for a database, whose container carries no prefix
  // at all (which is also why the agent's own `deplo-<slug>` fallback can never
  // remove one).
  const key = entry.deployKey;
  return rows
    .map((r) => r.name)
    .filter((n) => {
      const bare = n.startsWith("deplo-") ? n.slice("deplo-".length) : n;
      return bare === key || bare.startsWith(`${key}-`);
    });
}

/**
 * One verified attempt. `verifyFirst` is for a RETRY, where the key may have been
 * reclaimed since: nothing of ours left on the host means the work is done, and
 * destroying anyway would tear down whatever took the key.
 */
async function attemptTeardown(
  entry: TeardownEntry,
  opts: { verifyFirst: boolean },
): Promise<{ gone: boolean; error: string }> {
  let conn: TeardownAgent;
  try {
    conn = await dial(entry.serverId);
  } catch (e) {
    return { gone: false, error: errMsg(e) };
  }
  try {
    if (opts.verifyFirst) {
      const before = await stackContainers(conn, entry);
      if (before !== null && before.length === 0) return { gone: true, error: "" };
    }
    const res = await conn.destroyStack(entry.deployKey, true, entry.reclaimVolumes);
    const left = await stackContainers(conn, entry);
    // An agent too old for the probe (or one that errored on it) answers null:
    // we cannot verify, so the destroy's own verdict stands.
    if (left === null)
      return {
        gone: res.ok,
        error: res.ok ? "" : res.error || "the teardown failed",
      };
    if (left.length === 0) return { gone: true, error: "" };
    // Whatever survived must at least stop serving: the user asked for it to go.
    await conn.stopStack(entry.deployKey).catch(() => {});
    return {
      gone: false,
      error: `${left.length} container${left.length === 1 ? "" : "s"} survived the teardown${
        res.error ? ` (${res.error})` : ""
      }`,
    };
  } catch (e) {
    return { gone: false, error: errMsg(e) };
  } finally {
    conn.close();
  }
}

/** Book a failed attempt: bump the counter, back off, or give up out loud. */
async function recordFailure(
  entry: TeardownEntry,
  error: string,
  serverName: string,
  now: Date,
): Promise<void> {
  const rows = await getDb()
    .update(pendingTeardowns)
    .set({ attempts: sql`${pendingTeardowns.attempts} + 1`, lastError: error })
    .where(
      and(
        eq(pendingTeardowns.serverId, entry.serverId),
        eq(pendingTeardowns.deployKey, entry.deployKey),
      ),
    )
    .returning({ attempts: pendingTeardowns.attempts });
  const attempts = rows[0]?.attempts;
  if (attempts === undefined) return;
  const next = nextTeardownAttempt(attempts, now);
  if (!next.giveUp) {
    await getDb()
      .update(pendingTeardowns)
      .set({ nextAttemptAt: next.at })
      .where(
        and(
          eq(pendingTeardowns.serverId, entry.serverId),
          eq(pendingTeardowns.deployKey, entry.deployKey),
        ),
      );
    return;
  }
  await getDb()
    .update(pendingTeardowns)
    .set({ abandonedAt: nowIso() })
    .where(
      and(
        eq(pendingTeardowns.serverId, entry.serverId),
        eq(pendingTeardowns.deployKey, entry.deployKey),
      ),
    );
  await announce(
    entry,
    `Gave up on the teardown of ${entry.label} on ${serverName} after ${attempts} attempts: ${error}`,
    "teardown_abandoned",
  );
}

/**
 * Say what happened. A row with no team belongs to a team that no longer exists,
 * and `recordActivity` would fall back to the OLDEST team on the instance - a
 * stranger's audit trail. It gets the server alert instead, which fans out to
 * whoever still has something on that host.
 */
async function announce(
  entry: TeardownEntry,
  message: string,
  alert: "teardown_abandoned" | null,
): Promise<void> {
  if (entry.teamId) {
    await recordActivity("app", message, "Deplo", null, entry.teamId, alert);
    return;
  }
  console.warn(`[deplo] ${message}`);
  if (alert)
    dispatchServerAlert(entry.serverId, {
      key: alert,
      title: "Leftover containers",
      body: message,
      path: "/activity",
    });
}

/** The server's name and whether Deplo currently believes it is reachable. */
async function serverFacts(
  serverId: string,
): Promise<{ name: string; offline: boolean }> {
  const rows = await getDb()
    .select({ name: serversTable.name, status: serversTable.status })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  return {
    name: rows[0]?.name ?? "its server",
    offline: rows[0]?.status === "offline",
  };
}

/**
 * Queue the intent, then try it once. `true` means the host confirmed the stack
 * is gone and nothing was left queued.
 *
 * Writes no Activity of its own: the caller owns that copy, because the bulk
 * delete aggregates twenty apps into ONE line.
 */
export async function teardownOrQueue(entry: TeardownEntry): Promise<boolean> {
  await enqueueTeardowns([entry]);
  const { name, offline } = await serverFacts(entry.serverId);
  // ADR-0006 says `servers.status` is a cache and never a gate. It gates nothing
  // here: a host the health prober just found offline still gets torn down, one
  // minute later, from the drain. What it buys is not waiting out the 3-minute
  // stack deadline per app while somebody deletes twenty of them.
  if (offline) {
    await recordFailure(entry, `${name} is offline`, name, new Date());
    return false;
  }
  const { gone, error } = await attemptTeardown(entry, { verifyFirst: false });
  if (!gone) {
    await recordFailure(entry, error, name, new Date());
    return false;
  }
  await dropTeardown(entry.serverId, entry.deployKey);
  return true;
}

async function dropTeardown(serverId: string, deployKey: string): Promise<void> {
  await getDb()
    .delete(pendingTeardowns)
    .where(
      and(
        eq(pendingTeardowns.serverId, serverId),
        eq(pendingTeardowns.deployKey, deployKey),
      ),
    );
}

/**
 * Retry every teardown that is due. Called from the reaper tick, under its lease,
 * so two instances never dial the same host for the same stack. Never throws.
 */
export async function drainTeardowns(now: Date = new Date()): Promise<void> {
  await reopenReachableTeardowns(now).catch((e) =>
    console.error("[deplo] could not reopen teardowns:", errMsg(e)),
  );
  const due = await getDb()
    .select({
      serverId: pendingTeardowns.serverId,
      deployKey: pendingTeardowns.deployKey,
      projectLabel: pendingTeardowns.projectLabel,
      label: pendingTeardowns.label,
      teamId: pendingTeardowns.teamId,
      serverName: serversTable.name,
    })
    .from(pendingTeardowns)
    .innerJoin(serversTable, eq(serversTable.id, pendingTeardowns.serverId))
    .where(
      and(
        isNull(pendingTeardowns.abandonedAt),
        lte(pendingTeardowns.nextAttemptAt, now.toISOString()),
      ),
    )
    .orderBy(asc(pendingTeardowns.nextAttemptAt))
    .limit(DRAIN_BATCH);

  await mapLimit(due, DRAIN_CONCURRENCY, async (row) => {
    const entry: TeardownEntry = {
      serverId: row.serverId,
      deployKey: row.deployKey,
      projectLabel: row.projectLabel,
      label: row.label,
      teamId: row.teamId,
    };
    try {
      const { gone, error } = await attemptTeardown(entry, { verifyFirst: true });
      if (!gone) {
        await recordFailure(entry, error, row.serverName, now);
        return;
      }
      await dropTeardown(entry.serverId, entry.deployKey);
      await announce(
        entry,
        `Finished the teardown of ${entry.label} on ${row.serverName}`,
        null,
      );
    } catch (e) {
      console.error(
        `[deplo] teardown of ${row.deployKey} on ${row.serverName} did not finish:`,
        errMsg(e),
      );
    }
  });
}

/** How many teardowns are still queued for a host. */
export async function pendingTeardownsForServer(serverId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(pendingTeardowns)
    .where(eq(pendingTeardowns.serverId, serverId));
  return rows[0]?.n ?? 0;
}

/**
 * Give a new ladder to teardowns Deplo gave up on, once their host is answering
 * again. Giving up is how Deplo stops nagging, not a decision that the containers
 * may stay, and with no UI to resume one by hand this is the only way back.
 *
 * Two conditions, both cheap: the host is online and was seen minutes ago, and
 * the row was abandoned at least an hour ago. The second is what stops a stack
 * that fails for its OWN reasons (an agent error on a perfectly reachable host)
 * from reopening the moment it is abandoned and spinning forever.
 */
async function reopenReachableTeardowns(now: Date): Promise<void> {
  const db = getDb();
  const reachable = db
    .select({ id: serversTable.id })
    .from(serversTable)
    .where(
      and(
        eq(serversTable.status, "online"),
        gte(
          serversTable.lastSeenAt,
          new Date(now.getTime() - SEEN_RECENTLY_MS).toISOString(),
        ),
      ),
    );
  await db
    .update(pendingTeardowns)
    .set({ abandonedAt: null, attempts: 0, nextAttemptAt: now.toISOString() })
    .where(
      and(
        lte(
          pendingTeardowns.abandonedAt,
          new Date(now.getTime() - REOPEN_AFTER_MS).toISOString(),
        ),
        inArray(pendingTeardowns.serverId, reachable),
      ),
    );
}
