// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import type { ClientReadableStream } from "@grpc/grpc-js";

/**
 * The two stream bridges the agent client is built on, kept OUT of
 * `agent-client.ts` on purpose.
 */

/** How the agent's own error shape is normalised. Injected so this module keeps
 *  no dependency on the client's error hierarchy. */
type Normalise = (err: unknown) => Error;

/**
 * Bridge a grpc server-stream into a backpressured async generator.
 */
export async function* streamEvents<E>(
  stream: ClientReadableStream<E>,
  opts: { maxQueued?: number; pauseAbove?: number; normalise?: Normalise } = {},
): AsyncGenerator<E, void, unknown> {
  const maxQueued = opts.maxQueued ?? 0;
  const pauseAbove = opts.pauseAbove ?? 0;
  const normalise =
    opts.normalise ??
    ((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  const queue: E[] = [];
  let done = false;
  let paused = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const signal = () => {
    wake?.();
    wake = null;
  };
  stream.on("data", (ev: E) => {
    if (maxQueued > 0 && queue.length >= maxQueued) queue.shift();
    queue.push(ev);
    if (pauseAbove > 0 && !paused && queue.length >= pauseAbove) {
      paused = true;
      stream.pause();
    }
    signal();
  });
  stream.on("error", (err: Error) => {
    failure = normalise(err);
    done = true;
    signal();
  });
  stream.on("end", () => {
    done = true;
    signal();
  });
  try {
    while (true) {
      if (queue.length) {
        const ev = queue.shift()!;
        // Resume at HALF the bound, not at it: resuming the instant one slot
        // frees would toggle pause/resume on every single chunk, and the
        // syscall churn costs more than the buffer it saves.
        if (paused && !done && queue.length <= pauseAbove / 2) {
          paused = false;
          stream.resume();
        }
        yield ev;
        continue;
      }
      if (failure) throw failure;
      if (done) return;
      await new Promise<void>((r) => (wake = r));
    }
  } finally {
    stream.cancel();
  }
}

/**
 * Pump a header frame then a stream of byte frames into a client-streaming (or
 * bidi) call, honouring write backpressure.
 */
export function pumpClientStream<T>(
  call: {
    write(v: T): boolean;
    end(): void;
    cancel(): void;
  } & NodeJS.EventEmitter,
  headerFrame: T,
  chunks: AsyncIterable<Buffer>,
  dataFrame: (data: Buffer) => T,
  onError: (e: unknown) => void,
): void {
  let settled = false;
  const fail = (e: unknown) => {
    if (settled) return;
    settled = true;
    onError(e);
  };
  call.on("error", fail);

  const writeFrame = (v: T) =>
    new Promise<void>((res, rej) => {
      if (call.write(v)) return res();
      const onDrain = () => {
        call.off("error", onWriteError);
        res();
      };
      const onWriteError = (e: Error) => {
        call.off("drain", onDrain);
        rej(e);
      };
      call.once("drain", onDrain);
      call.once("error", onWriteError);
    });

  void (async () => {
    try {
      await writeFrame(headerFrame);
      for await (const buf of chunks) {
        if (settled) return; // a transport error already ended us
        await writeFrame(dataFrame(buf));
      }
      call.end();
    } catch (e) {
      call.cancel();
      fail(e);
    }
  })();
}
