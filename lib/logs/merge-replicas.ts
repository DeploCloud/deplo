import { StringDecoder } from "node:string_decoder";

import type { AttachHandle } from "../attach/types";
import { splitTimestamp } from "./window";

export interface ReplicaSource {
  tag: string;
  handle: AttachHandle;
}

// The replayed tail of every replica is sorted by time before the stream goes live.
const SETTLE_MS = 150;
const MAX_BURST_MS = 1_500;

interface Line {
  ts: string;
  text: string;
  seq: number;
}

// One stream of tagged lines out of several replicas' logs. The sources MUST be opened with timestamps:
// they order the replayed tail, and are dropped again unless the viewer asked for them.
export function mergeReplicaLogs(
  sources: ReplicaSource[],
  opts: { timestamps: boolean; settleMs?: number; notices?: string[] },
): AttachHandle {
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const width = Math.max(...sources.map((s) => s.tag.length));
  const listeners = new Set<(chunk: Buffer) => void>();
  const exitListeners: ((error?: string) => void)[] = [];
  let burst: Line[] | null = [];
  let quiet: NodeJS.Timeout | undefined;
  let hard: NodeJS.Timeout | undefined;
  let seq = 0;
  let open = sources.length;
  let firstError: string | undefined;
  let done = false;

  const render = (tag: string, line: string): Line => {
    const { ts, rest } = splitTimestamp(line);
    const tagged = `${tag.padEnd(width)} | ${rest}`;
    const text = opts.timestamps && ts ? `${ts} ${tagged}` : tagged;
    return { ts: ts ?? "", text: `${text}\n`, seq: seq++ };
  };

  const emit = (lines: Line[]) => {
    if (lines.length === 0) return;
    const chunk = Buffer.from(lines.map((l) => l.text).join(""));
    for (const cb of listeners) cb(chunk);
  };

  const flush = () => {
    clearTimeout(quiet);
    clearTimeout(hard);
    if (!burst) return;
    const lines = burst;
    burst = null;
    emit(
      lines.sort((a, b) =>
        a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq,
      ),
    );
  };

  const take = (line: Line) => {
    if (!burst) return emit([line]);
    burst.push(line);
  };

  const touch = () => {
    if (!burst) return;
    clearTimeout(quiet);
    quiet = setTimeout(flush, settleMs);
    hard ??= setTimeout(flush, MAX_BURST_MS);
  };

  const finish = () => {
    if (done) return;
    done = true;
    flush();
    for (const cb of exitListeners) cb(firstError);
  };

  // What the stream has to say ahead of the logs themselves: no time, so it sorts first.
  for (const text of opts.notices ?? [])
    burst.push({ ts: "", text: `${text}\n`, seq: seq++ });
  if (opts.notices?.length) touch();

  for (const { tag, handle } of sources) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    handle.onData((chunk) => {
      pending += decoder.write(chunk);
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        take(render(tag, pending.slice(0, nl).replace(/\r$/, "")));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
      touch();
    });
    handle.onExit((error) => {
      pending += decoder.end();
      if (pending) take(render(tag, pending));
      pending = "";
      firstError ??= error;
      if (--open === 0) finish();
    });
  }

  return {
    onData(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onExit(cb) {
      if (done) cb(firstError);
      else exitListeners.push(cb);
    },
    write() {},
    close() {
      clearTimeout(quiet);
      clearTimeout(hard);
      for (const s of sources) s.handle.close();
    },
  };
}
