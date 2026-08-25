import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { streamEvents } from "./stream-events";
import type { ClientReadableStream } from "@grpc/grpc-js";

/**
 * `streamEvents` bridges a gRPC server-stream into an async generator, and its
 * THREE modes exist for three genuinely different payloads: - unbounded (the
 * default) for log lines, where dropping one loses information permanently; -
 */

/** A stand-in for a grpc-js readable: an emitter that records pause/resume. */
class FakeStream<E> extends EventEmitter {
  paused = false;
  pauses = 0;
  resumes = 0;
  cancelled = false;

  pause(): this {
    this.paused = true;
    this.pauses++;
    return this;
  }
  resume(): this {
    this.paused = false;
    this.resumes++;
    return this;
  }
  cancel(): void {
    this.cancelled = true;
  }
  /** Emit one frame, honouring the pause the consumer asked for. */
  push(ev: E): boolean {
    if (this.paused) return false;
    this.emit("data", ev);
    return true;
  }
  asStream(): ClientReadableStream<E> {
    return this as unknown as ClientReadableStream<E>;
  }
}

/** Let queued microtasks (the generator's own awaits) settle. */
const settle = () => new Promise((r) => setImmediate(r));

/**
 * Prime the generator so its listeners are attached. Real callers always `for
 * await` immediately, so this only matters here; every test below holds the first
 * pull's promise, pushes, and then reads.
 */
async function prime<E>(
  gen: AsyncGenerator<E, void, unknown>,
): Promise<{ first: Promise<IteratorResult<E, void>> }> {
  const first = gen.next();
  await settle();
  // BOXED, not returned bare: `await` unwraps a promise-of-a-promise recursively, so
  // returning `first` directly would make `await prime(gen)` block until the first
  // frame arrives — which is exactly what has not been pushed yet.
  return { first };
}

test("pauseAbove pauses the producer at the bound and resumes on drain", async () => {
  const s = new FakeStream<number>();
  const gen = streamEvents<number>(s.asStream(), { pauseAbove: 4 });
  const { first } = await prime(gen);

  // The first pull consumes frame 0 as soon as it arrives, so push five to leave
  // four actually queued. The fourth queued frame is the one that trips the
  // bound — reaching it is the signal, not exceeding it.
  s.push(0);
  assert.equal((await first).value, 0);
  for (let i = 1; i <= 3; i++)
    assert.equal(s.push(i), true, `frame ${i} accepted`);
  assert.equal(s.paused, false, "under the bound the producer runs free");
  assert.equal(s.push(4), true);
  assert.equal(s.paused, true, "at the bound the producer is paused");
  assert.equal(s.pauses, 1);

  // A paused producer emits nothing more — which is the whole point: without
  // this the queue grows to the size of the artifact.
  assert.equal(s.push(99), false, "a paused stream delivers nothing");

  // Consume down to half the bound; that is where it resumes.
  assert.equal((await gen.next()).value, 1);
  await settle();
  assert.equal(s.paused, true, "one slot free is not enough to resume");
  assert.equal((await gen.next()).value, 2);
  await settle();
  assert.equal(s.paused, false, "at half the bound the producer resumes");
  assert.equal(s.resumes, 1);

  // Nothing was lost along the way.
  assert.equal((await gen.next()).value, 3);
  assert.equal((await gen.next()).value, 4);
  s.emit("end");
  assert.equal((await gen.next()).done, true);
});

test("pauseAbove never drops a frame — it refuses the producer instead", async () => {
  const s = new FakeStream<number>();
  const gen = streamEvents<number>(s.asStream(), { pauseAbove: 2 });
  const { first } = await prime(gen);

  // Two frames fill the bound in a single tick, and the THIRD is refused rather
  // than accepted-and-discarded. That is the whole difference from maxQueued:
  // the producer is told to wait, so a real agent simply sends it later.
  assert.equal(s.push(0), true);
  assert.equal(s.push(1), true);
  assert.equal(s.paused, true);
  assert.equal(s.push(2), false, "the third frame is refused, not dropped");

  const got = [(await first).value];
  await settle();
  // Draining resumed the producer, so the frame it was holding gets through.
  assert.equal(s.paused, false);
  assert.equal(s.push(2), true);
  s.emit("end");
  for await (const v of gen) got.push(v);
  assert.deepEqual(got, [0, 1, 2], "every frame arrives, in order, none lost");
});

test("maxQueued still drops the OLDEST — telemetry's contract is unchanged", async () => {
  const s = new FakeStream<number>();
  const gen = streamEvents<number>(s.asStream(), { maxQueued: 2 });
  const { first } = await prime(gen);
  for (let i = 0; i < 5; i++) s.push(i);
  assert.equal(
    s.paused,
    false,
    "the drop-oldest mode must not pause the producer",
  );
  s.emit("end");

  const got = [(await first).value];
  for await (const v of gen) got.push(v);
  // All five arrive in ONE tick, so the suspended consumer never gets to take any of
  // them mid-flight: the queue drops down to the newest two, and that is what the
  // pull sees.
  assert.deepEqual(got, [3, 4]);
});

test("the default is unbounded and never pauses — a log line is never dropped", async () => {
  const s = new FakeStream<number>();
  const gen = streamEvents<number>(s.asStream());
  const { first } = await prime(gen);
  for (let i = 0; i < 50; i++) s.push(i);
  assert.equal(s.paused, false);
  s.emit("end");

  const got = [(await first).value];
  for await (const v of gen) got.push(v);
  assert.equal(got.length, 50);
});

test("a transport error surfaces after the frames already queued", async () => {
  const s = new FakeStream<number>();
  const gen = streamEvents<number>(s.asStream(), { pauseAbove: 8 });
  const { first } = await prime(gen);
  s.push(1);
  assert.equal((await first).value, 1);
  s.push(2);
  s.emit("error", new Error("boom"));

  // The queued frame is delivered first: it really arrived, and discarding it
  // would lose a log line the operator needs to understand the failure.
  assert.equal((await gen.next()).value, 2);
  await assert.rejects(() => gen.next());
});

test("abandoning the generator cancels the RPC", async () => {
  const s = new FakeStream<number>();
  const gen = streamEvents<number>(s.asStream(), { pauseAbove: 4 });
  const { first } = await prime(gen);
  s.push(1);
  assert.equal((await first).value, 1);
  // Walking away from a relay must stop the agent producing, not leave it
  // writing into a socket nobody reads for the rest of the deadline.
  await gen.return(undefined);
  assert.equal(s.cancelled, true);
});
