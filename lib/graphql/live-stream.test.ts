import { test } from "node:test";
import assert from "node:assert/strict";

import { createPubSub } from "@graphql-yoga/subscription";

import { liveStream } from "./live-stream";

type Channels = { ping: [topic: string, payload: string] };

const settlesWithin = <T>(p: Promise<T>, ms = 200) =>
  Promise.race([
    p.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);

function skippingStream(pubSub: ReturnType<typeof createPubSub<Channels>>) {
  const seen: string[] = [];
  let ended = false;
  const stream = liveStream(async function* (track): AsyncGenerator<number> {
    try {
      yield 0;
      for await (const p of track(pubSub.subscribe("ping", "t"))) {
        seen.push(p);
        if (p === "skip") continue;
        yield 1;
      }
    } finally {
      ended = true;
    }
  });
  return { stream, seen, isEnded: () => ended };
}

test("return() ends an idle stream at once, without waiting for a ping", async () => {
  const pubSub = createPubSub<Channels>();
  const { stream, seen, isEnded } = skippingStream(pubSub);
  assert.equal((await stream.next()).value, 0);
  const pending = stream.next();
  await new Promise((r) => setImmediate(r));
  pubSub.publish("ping", "t", "skip");
  await new Promise((r) => setImmediate(r));

  assert.equal(await settlesWithin(stream.return()), true);
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(isEnded(), true);

  pubSub.publish("ping", "t", "late");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["skip"]);
});

test("return() before the first pull never subscribes", async () => {
  const pubSub = createPubSub<Channels>();
  const { stream, seen } = skippingStream(pubSub);
  assert.equal(await settlesWithin(stream.return()), true);
  pubSub.publish("ping", "t", "late");
  assert.deepEqual(seen, []);
  assert.equal((await stream.next()).done, true);
});

test("a stream still yields on pings and surfaces a body error", async () => {
  const pubSub = createPubSub<Channels>();
  const { stream } = skippingStream(pubSub);
  await stream.next();
  const next = stream.next();
  await new Promise((r) => setImmediate(r));
  pubSub.publish("ping", "t", "go");
  assert.equal((await next).value, 1);
  await stream.return();

  const failing = liveStream(async function* (): AsyncGenerator<number> {
    throw new Error("nope");
  });
  await assert.rejects(() => failing.next(), /nope/);
});
