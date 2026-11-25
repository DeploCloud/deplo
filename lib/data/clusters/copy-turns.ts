import "server-only";

// A server takes one copy at a time, sent or received (ADR-0043): eu-2, one core, took a backup and two
// replicas at once and every App through it timed out (c37). The others wait their turn, and say so.

/** How a copy that waits its turn starts the words its row shows. */
export const QUEUED = "Queued:";

type Turn = { what: string };

// On globalThis: backups run in the scheduler's bundle, the replication pass in the watch's.
const KEY = Symbol.for("deplo.clusters.copy-turns");
const state = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  held: new Map<string, Turn>(),
  replicas: new Map<string, string>(),
  notes: new Map<string, Wait>(),
  copies: { bytes: new Map(), turns: new Set(), waiting: new Map() },
}) as {
  held: Map<string, Turn>;
  replicas: Map<string, string>;
  notes: Map<string, Wait>;
  copies: CopyMemory;
};

/** What the replication pass keeps of each copy ("<server>|<app>") from one pass to the next. */
export interface CopyMemory {
  /** The bytes it had received at the last pass. */
  bytes: Map<string, number>;
  /** The copies that held their servers' turn at the last pass: they keep it while they copy. */
  turns: Set<string>;
  /** Since when a copy the queue holds has waited. */
  waiting: Map<string, number>;
}

export const copyMemory = (): CopyMemory => state.copies;

type Wait = { serverId: string; what: string };

/** Why a backup run waits, while it does: the server it waits for and what that one copies; null once it runs. */
export function queuedNote(runId: string): Wait | null {
  return state.notes.get(runId) ?? null;
}

/** What a server copies now, in words ("a backup of Fise"); null while its turn is free. */
export function busyWith(serverId: string): string | null {
  return state.held.get(serverId)?.what ?? state.replicas.get(serverId) ?? null;
}

/** A backup or a move on this server now, which no new replica starts beside. */
export function heldBy(serverId: string): string | null {
  return state.held.get(serverId)?.what ?? null;
}

/** The replication pass's word: each server's copy not whole yet. */
export function setReplicaTurns(busy: Map<string, string>): void {
  state.replicas = busy;
}

/** Vars so tests hurry them. A stuck copy holds another one at most `maxMs`: then it goes anyway. */
export const turnWait = { pollMs: 5_000, maxMs: 30 * 60_000 };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), {
      once: true,
    });
  });

/**
 * Waits until none of `serverIds` copies anything, then holds their turn for `what` until the release. `queued`
 * hears once which server it waits for and what that one copies.
 */
export async function takeTurn(
  serverIds: string[],
  what: string,
  opts: {
    queued?: (serverId: string, busy: string) => void | Promise<void>;
    signal?: AbortSignal;
    /** A run whose wait its row shows. */
    note?: string;
  } = {},
): Promise<() => void> {
  const ids = [...new Set(serverIds.filter(Boolean))];
  const until = Date.now() + turnWait.maxMs;
  let said = false;
  while (!opts.signal?.aborted && Date.now() < until) {
    const busy = ids.find((id) => busyWith(id));
    if (!busy) break;
    if (!said) {
      said = true;
      await opts.queued?.(busy, busyWith(busy)!);
    }
    if (opts.note)
      state.notes.set(opts.note, { serverId: busy, what: busyWith(busy)! });
    await sleep(turnWait.pollMs, opts.signal);
  }
  if (opts.note) state.notes.delete(opts.note);
  return holdTurn(ids, what);
}

/** Holds the servers' turn for `what` at once, whatever they copy now: for a copy whose App is down until it runs. */
export function holdTurn(serverIds: string[], what: string): () => void {
  const turn: Turn = { what };
  const ids = [...new Set(serverIds.filter(Boolean))];
  for (const id of ids) state.held.set(id, turn);
  return () => {
    for (const id of ids)
      if (state.held.get(id) === turn) state.held.delete(id);
  };
}

/** Test seam. */
export function __forgetTurns(): void {
  state.held.clear();
  state.notes.clear();
  state.replicas = new Map();
  state.copies = { bytes: new Map(), turns: new Set(), waiting: new Map() };
}
