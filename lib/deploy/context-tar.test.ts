import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { tarDir, tarDirChunks } from "./context-tar";
import { tarEntries } from "../infra/tar-stream";

async function fixture(): Promise<{ dir: string; big: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), "deplo-ctx-"));
  const big = randomBytes(300_000);
  await writeFile(join(dir, "Dockerfile"), "FROM scratch\n");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "big.bin"), big);
  return { dir, big };
}

async function* fromBuffers(parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const p of parts) yield p;
}

test("tarDirChunks cuts the archive into fixed chunks that rebuild the same tar", async () => {
  const { dir, big } = await fixture();
  try {
    const parts: Buffer[] = [];
    for await (const c of tarDirChunks(dir, 64 * 1024)) parts.push(c);
    assert.ok(parts.length > 2, "a 300 KB tree spans several 64 KiB chunks");
    for (const p of parts.slice(0, -1)) assert.equal(p.length, 64 * 1024);
    assert.ok(parts.at(-1)!.length <= 64 * 1024);

    const whole = Buffer.from(await tarDir(dir));
    assert.deepEqual(Buffer.concat(parts), whole);

    const names = new Map<string, Buffer | null>();
    for await (const e of tarEntries(fromBuffers(parts), {
      read: () => true,
    })) {
      names.set(e.name.replace(/^\.\//, ""), e.bytes);
    }
    assert.equal(names.get("Dockerfile")?.toString(), "FROM scratch\n");
    assert.deepEqual(names.get("src/big.bin"), big);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tarDirChunks stops tar when the consumer stops early", async () => {
  const { dir } = await fixture();
  try {
    const gen = tarDirChunks(dir, 1024);
    const first = await gen.next();
    assert.equal(first.done, false);
    await gen.return();
    assert.deepEqual(await gen.next(), { done: true, value: undefined });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tarDirChunks fails on a missing folder", async () => {
  await assert.rejects(async () => {
    for await (const _ of tarDirChunks("/nonexistent/deplo-ctx")) void _;
  }, /tar exited/);
});
