import type { ClientReadableStream } from "@grpc/grpc-js";

/**
 * The two stream bridges the agent client is built on, kept OUT of
 * `agent-client.ts` on purpose.
 *
 * They are pure plumbing over a grpc-js stream — no Postgres, no PKI, no server
 * lookup — and `agent-client` is none of those things: importing it pulls in the
 * data layer and opens a connection pool, which is enough to keep a test
 * process's event loop alive forever. A bridge whose whole job is backpressure
 * deserves a test that runs in a few milliseconds and exits.
 */

/** How the agent's own error shape is normalised. Injected so this module keeps
 *  no dependency on the client's error hierarchy. */
type Normalise = (err: unknown) => Error;

/** Bridge a grpc server-stream into a backpressured async generator. Generic
 *  over the event type so the deploy/reattach streams AND the
 *  backup/restore streams (same one-request-many-events shape) reuse it. A
 *  transport-down error is normalised so consumers catch AgentUnreachableError.
 *
 *  `maxQueued` bounds the buffer for a stream that runs for HOURS. The default
 *  (0, unbounded) is right for the finite deploy/backup streams, where every
 *  event is a log line the operator must eventually see and dropping one loses
 *  information permanently. It is wrong for telemetry: if a consumer stalls,
 *  an unbounded queue grows without limit, and the samples it accumulates are
 *  worthless by the time they drain — a metrics point that arrives a minute
 *  late is not late data, it is wrong data. So a bounded queue DROPS THE
 *  OLDEST rather than pausing the producer or growing.
 *
 *  `pauseAbove` is the third mode, and the only correct one for a stream whose
 *  events carry BYTES rather than log lines: dropping a chunk corrupts the
 *  artifact, and buffering without limit puts the whole transfer in the control
 *  plane's heap — a multi-GB volume or backup relayed from a fast host to a slow
 *  one would OOM the control plane, and neither of the other two modes prevents
 *  it. Above the bound the underlying stream is PAUSED, so backpressure reaches
 *  the agent through the gRPC flow-control window and the producer slows down
 *  instead of us growing. Set it on EVERY data-carrying stream. */
export async function* streamEvents<E>(
  stream: ClientReadableStream<E>,
  opts: { maxQueued?: number; pauseAbove?: number; normalise?: Normalise } = {},
): AsyncGenerator<E, void, unknown> {
  const maxQueued = opts.maxQueued ?? 0;
  const pauseAbove = opts.pauseAbove ?? 0;
  const normalise = opts.normalise ?? ((e: unknown) =>
    e instanceof Error ? e : new Error(String(e)));
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
 *
 * Four RPCs need exactly this — ImportVolume, ImportFiles, WriteStoreFile and
 * RestoreFrom — and the two subtleties are why it is one function rather than
 * four copies:
 *
 *  - `write()` returning false means the socket is full, and the pump must
 *    await `"drain"`. Both listeners are removed on settle: a bare `once()` per
 *    chunk leaves the loser registered, leaking one listener + closure per
 *    backpressured frame for the life of a multi-GB transfer.
 *  - A throw mid-pump CANCELS the call, so the agent's untar/write sees the
 *    break instead of committing a truncated artifact.
 */
export function pumpClientStream<T>(
  call: { write(v: T): boolean; end(): void; cancel(): void } & NodeJS.EventEmitter,
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

