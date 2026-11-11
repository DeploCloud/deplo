import { test } from "node:test";
import assert from "node:assert/strict";

import type { AttachHandle } from "../infra/docker";
import { mergeReplicaLogs } from "./merge-replicas";

function source() {
  const data = new Set<(c: Buffer) => void>();
  let exit: ((e?: string) => void) | null = null;
  let closed = 0;
  const handle: AttachHandle = {
    onData: (cb) => {
      data.add(cb);
      return () => data.delete(cb);
    },
    onExit: (cb) => {
      exit = cb;
    },
    write: () => {},
    close: () => {
      closed++;
    },
  };
  return {
    handle,
    push: (s: string) => data.forEach((cb) => cb(Buffer.from(s))),
    end: (e?: string) => exit?.(e),
    closed: () => closed,
  };
}

const T = (n: number) => `2026-11-10T10:00:0${n}.000000000Z`;
const settle = () => new Promise((r) => setTimeout(r, 40));

function collect(h: AttachHandle) {
  let out = "";
  h.onData((c) => (out += c.toString()));
  return () => out;
}

test("each line is tagged with its replica", async () => {
  const a = source();
  const b = source();
  const merged = mergeReplicaLogs(
    [
      { tag: "web-1", handle: a.handle },
      { tag: "web-2", handle: b.handle },
    ],
    { timestamps: false, settleMs: 10 },
  );
  const read = collect(merged);
  a.push(`${T(1)} hello\n`);
  b.push(`${T(2)} world\n`);
  await settle();
  assert.equal(read(), "web-1 | hello\nweb-2 | world\n");
});

test("the replayed tail is in time order across replicas", async () => {
  const a = source();
  const b = source();
  const merged = mergeReplicaLogs(
    [
      { tag: "web-1", handle: a.handle },
      { tag: "web-2", handle: b.handle },
    ],
    { timestamps: false, settleMs: 10 },
  );
  const read = collect(merged);
  a.push(`${T(1)} one\n${T(4)} four\n`);
  b.push(`${T(2)} two\n${T(3)} three\n`);
  await settle();
  assert.deepEqual(read().trimEnd().split("\n"), [
    "web-1 | one",
    "web-2 | two",
    "web-2 | three",
    "web-1 | four",
  ]);
});

test("a viewer that asked for timestamps keeps them, before the tag", async () => {
  const a = source();
  const merged = mergeReplicaLogs([{ tag: "web-1", handle: a.handle }], {
    timestamps: true,
    settleMs: 10,
  });
  const read = collect(merged);
  a.push(`${T(1)} hi\n`);
  await settle();
  assert.equal(read(), `${T(1)} web-1 | hi\n`);
});

test("a line split across chunks is tagged once, and live lines follow at once", async () => {
  const a = source();
  const b = source();
  const merged = mergeReplicaLogs(
    [
      { tag: "web-1", handle: a.handle },
      { tag: "web-2", handle: b.handle },
    ],
    { timestamps: false, settleMs: 10 },
  );
  const read = collect(merged);
  a.push(`${T(1)} par`);
  await settle();
  assert.equal(read(), "");
  a.push(`tial\n`);
  await settle();
  assert.equal(read(), "web-1 | partial\n");
  b.push(`${T(5)} live\n`);
  assert.equal(read(), "web-1 | partial\nweb-2 | live\n");
});

test("tags line up", async () => {
  const a = source();
  const b = source();
  const merged = mergeReplicaLogs(
    [
      { tag: "web-1", handle: a.handle },
      { tag: "worker-10", handle: b.handle },
    ],
    { timestamps: false, settleMs: 10 },
  );
  const read = collect(merged);
  a.push(`${T(1)} x\n`);
  await settle();
  assert.equal(read(), "web-1     | x\n");
});

test("it exits when every replica has, and closing closes them all", async () => {
  const a = source();
  const b = source();
  const merged = mergeReplicaLogs(
    [
      { tag: "web-1", handle: a.handle },
      { tag: "web-2", handle: b.handle },
    ],
    { timestamps: false, settleMs: 10 },
  );
  const exits: (string | undefined)[] = [];
  merged.onExit((e) => exits.push(e));
  a.push(`${T(1)} tail without newline`);
  a.end();
  assert.equal(exits.length, 0, "one replica ending is not the end");
  b.end("boom");
  assert.deepEqual(exits, ["boom"]);
  merged.close();
  assert.equal(a.closed(), 1);
  assert.equal(b.closed(), 1);
});

test("a replica that ends flushes its last unfinished line", async () => {
  const a = source();
  const merged = mergeReplicaLogs([{ tag: "web-1", handle: a.handle }], {
    timestamps: false,
    settleMs: 10,
  });
  const read = collect(merged);
  a.push(`${T(1)} last`);
  a.end();
  assert.equal(read(), "web-1 | last\n");
});

test("a notice goes out once, ahead of the logs, even while every replica is quiet", async () => {
  const a = source();
  const merged = mergeReplicaLogs([{ tag: "web-1", handle: a.handle }], {
    timestamps: true,
    settleMs: 10,
    notices: ["Earlier logs on server-a are unavailable."],
  });
  const read = collect(merged);
  await settle();
  assert.equal(read(), "Earlier logs on server-a are unavailable.\n");
  a.push(`${T(1)} hi\n`);
  assert.equal(
    read(),
    `Earlier logs on server-a are unavailable.\n${T(1)} web-1 | hi\n`,
  );
});
