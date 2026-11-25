import "server-only";

// A server takes one copy at a time, sent or received (ADR-0043): eu-2, one core, took a backup and two
// replicas at once and every App through it timed out (c37). The others wait in the order they asked, and say so.

/** How a copy that waits its turn starts the words its row shows. */
export const QUEUED = "Queued:";

type Turn = { what: string };

/** A copy waiting in line: its servers, what it is, and when it first asked. */
type Ticket = { servers: string[]; what: string; seq: number; kind: string };

// On globalThis: backups run in the scheduler's bundle, the replication pass in the watch's.
const KEY = Symbol.for("deplo.clusters.copy-turns");
const state = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  held: new Map<string, Turn>(),
  replicas: new Map<string, string>(),
  notes: new Map<string, Place>(),
  line: new Map<string, Ticket>(),
  seq: 0,
  copies: { bytes: new Map(), turns: new Set(), waiting: new Map() },
}) as {
  held: Map<string, Turn>;
  replicas: Map<string, string>;
  notes: Map<string, Place>;
  line: Map<string, Ticket>;
  seq: number;
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

/** A copy's place in line (1 goes next), the server it waits for, and what that one copies or lets go first. */
export type Place = {
  place: number;
  serverId: string;
  what: string;
  busy: boolean;
};

/** Why a backup run waits, while it does: its place and what holds it up; null once it runs. */
export function queuedNote(runId: string): Place | null {
  return state.notes.get(runId) ?? null;
}

type Busy = (serverId: string) => string | null;

/** Joins the line once: a copy keeps the place of the first time it asked. */
export function joinLine(
  key: string,
  servers: string[],
  what: string,
  kind: string,
): void {
  if (!state.line.has(key))
    state.line.set(key, {
      servers: [...new Set(servers.filter(Boolean))],
      what,
      seq: ++state.seq,
      kind,
    });
}

export function leaveLine(key: string): void {
  state.line.delete(key);
}

/** Drops every copy of another kind in line on these servers: a server is in one cluster, so what another one left is stale. */
export function leaveLineOn(servers: string[], keep: string): void {
  for (const [k, t] of state.line)
    if (
      t.kind.startsWith("replica:") &&
      t.kind !== keep &&
      t.servers.some((id) => servers.includes(id))
    )
      state.line.delete(k);
}

/** The keys of one kind of copy in line, first asked first. */
export function lineOf(kind: string): string[] {
  return [...state.line]
    .filter(([, t]) => t.kind === kind)
    .sort(([, a], [, b]) => a.seq - b.seq)
    .map(([k]) => k);
}

const ahead = (t: Ticket) =>
  [...state.line.values()]
    .filter(
      (o) => o.seq < t.seq && o.servers.some((id) => t.servers.includes(id)),
    )
    .sort((a, b) => a.seq - b.seq);

/** Where a copy in line stands, with `busy` saying what each server copies now; null when it is not in line. */
export function placeOf(key: string, busy: Busy = busyWith): Place | null {
  const t = state.line.get(key);
  if (!t) return null;
  const before = ahead(t);
  const at = t.servers.find((id) => busy(id));
  if (at)
    return {
      place: before.length + 1,
      serverId: at,
      what: busy(at)!,
      busy: true,
    };
  if (before.length === 0) return null;
  const first = before[0]!;
  return {
    place: before.length + 1,
    serverId: first.servers.find((id) => t.servers.includes(id))!,
    what: first.what,
    busy: false,
  };
}

/** Whether a copy in line goes now: none of its servers copies, and nobody before it waits for one of them. */
export function mayGo(key: string, busy: Busy = busyWith): boolean {
  return placeOf(key, busy) === null;
}

const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/** A place in words: "2nd in line: eu-1 is busy with a copy of web". */
export function placeWords(p: Place, serverName: string): string {
  return p.busy
    ? `${ordinal(p.place)} in line: ${serverName} is busy with ${p.what}`
    : `${ordinal(p.place)} in line: ${serverName} takes ${p.what} first`;
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
 * Waits in line until none of `serverIds` copies anything and nobody who asked before waits for one of them, then
 * holds their turn for `what` until the release. `queued` hears once which server it waits for and what that one copies.
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
  const key = opts.note ?? `turn_${state.seq + 1}`;
  joinLine(key, ids, what, "backup");
  let said = false;
  try {
    while (!opts.signal?.aborted && Date.now() < until) {
      const p = placeOf(key);
      if (!p) break;
      if (!said) {
        said = true;
        await opts.queued?.(p.serverId, p.what);
      }
      if (opts.note) state.notes.set(opts.note, p);
      await sleep(turnWait.pollMs, opts.signal);
    }
  } finally {
    leaveLine(key);
    if (opts.note) state.notes.delete(opts.note);
  }
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
  state.line.clear();
  state.replicas = new Map();
  state.copies = { bytes: new Map(), turns: new Set(), waiting: new Map() };
}
