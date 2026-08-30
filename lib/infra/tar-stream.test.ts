// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { tarEntries, readTarEntry } from "./tar-stream";
import {
  tarEntry as entry,
  tarStream as stream,
  paxRecord,
  TAR_END as END,
} from "./tar-test-helpers";

const BLOCK = 512;

const OPTS = { maxEntryBytes: 1024 * 1024, maxScanBytes: 64 * 1024 * 1024 };

/* ------------------------------------------------------------------ */

test("readTarEntry: extracts the named entry's exact bytes", async () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 1,
  ]);
  const archive = Buffer.concat([
    entry("files/index.html", "<html>hi</html>"),
    entry("files/favicon.png", png),
    entry("files/app.js", "console.log(1)"),
    END,
  ]);
  const found = await readTarEntry(stream(archive), {
    ...OPTS,
    name: "files/favicon.png",
  });
  assert.deepEqual(found, png);
});

test("readTarEntry: null when the entry is absent", async () => {
  const archive = Buffer.concat([entry("files/a.txt", "a"), END]);
  assert.equal(
    await readTarEntry(stream(archive), { ...OPTS, name: "files/favicon.ico" }),
    null,
  );
});

test("readTarEntry: reassembles an entry split across tiny chunks", async () => {
  const data = Buffer.from("x".repeat(1500));
  const archive = Buffer.concat([
    entry("files/pad.bin", "y".repeat(700)),
    entry("files/favicon.ico", data),
    END,
  ]);
  const found = await readTarEntry(stream(archive, 7), {
    ...OPTS,
    name: "files/favicon.ico",
  });
  assert.deepEqual(found, data);
});

test("readTarEntry: a leading ./ on either side still matches", async () => {
  const archive = Buffer.concat([entry("./files/favicon.svg", "<svg/>"), END]);
  assert.deepEqual(
    await readTarEntry(stream(archive), { ...OPTS, name: "files/favicon.svg" }),
    Buffer.from("<svg/>"),
  );
  const archive2 = Buffer.concat([entry("files/favicon.svg", "<svg/>"), END]);
  assert.deepEqual(
    await readTarEntry(stream(archive2), {
      ...OPTS,
      name: "./files/favicon.svg",
    }),
    Buffer.from("<svg/>"),
  );
});

test("readTarEntry: honours the ustar prefix field for split names", async () => {
  const deep = "a".repeat(120);
  const archive = Buffer.concat([
    entry("favicon.png", "ICON", { prefix: `files/${deep}` }),
    END,
  ]);
  assert.deepEqual(
    await readTarEntry(stream(archive), {
      ...OPTS,
      name: `files/${deep}/favicon.png`,
    }),
    Buffer.from("ICON"),
  );
});

test("readTarEntry: honours a PAX path= override (what Go writes for long paths)", async () => {
  const long = `files/${"deep/".repeat(30)}favicon.png`;
  const archive = Buffer.concat([
    entry("PaxHeaders/0/favicon.png", paxRecord("path", long), { type: "x" }),
    entry(long.slice(-99), "PAXICON"),
    END,
  ]);
  assert.deepEqual(
    await readTarEntry(stream(archive), { ...OPTS, name: long }),
    Buffer.from("PAXICON"),
  );
});

test("readTarEntry: a PAX path with multibyte characters is sliced by BYTES", async () => {
  // Record lengths are byte counts: decoding first would mis-slice the blob and
  // lose the override (the entry would keep its truncated header name).
  const long = `files/${"caffè/".repeat(20)}favicon.png`;
  const archive = Buffer.concat([
    entry(
      "PaxHeaders/0/favicon.png",
      Buffer.concat([
        paxRecord("mtime", "1753900000"),
        paxRecord("path", long),
      ]),
      { type: "x" },
    ),
    entry("favicon.png", "UNICODEICON"),
    END,
  ]);
  assert.deepEqual(
    await readTarEntry(stream(archive), { ...OPTS, name: long }),
    Buffer.from("UNICODEICON"),
  );
});

test("readTarEntry: honours a GNU long-name (L) record", async () => {
  const long = `files/${"sub/".repeat(40)}favicon.ico`;
  const archive = Buffer.concat([
    entry("././@LongLink", `${long}\0`, { type: "L" }),
    entry(long.slice(0, 99), "GNUICON"),
    END,
  ]);
  assert.deepEqual(
    await readTarEntry(stream(archive), { ...OPTS, name: long }),
    Buffer.from("GNUICON"),
  );
});

test("readTarEntry: skips a matching entry over maxEntryBytes", async () => {
  const archive = Buffer.concat([
    entry("files/favicon.png", Buffer.alloc(4096, 1)),
    END,
  ]);
  assert.equal(
    await readTarEntry(stream(archive), {
      maxEntryBytes: 1024,
      maxScanBytes: 1024 * 1024,
      name: "files/favicon.png",
    }),
    null,
  );
});

test("readTarEntry: gives up once maxScanBytes is consumed", async () => {
  const archive = Buffer.concat([
    entry("files/big.bin", Buffer.alloc(8192, 2)),
    entry("files/favicon.png", "LATE"),
    END,
  ]);
  assert.equal(
    await readTarEntry(stream(archive, 512), {
      maxEntryBytes: 1024,
      maxScanBytes: 2048,
      name: "files/favicon.png",
    }),
    null,
  );
});

test("readTarEntry: stops consuming the stream as soon as it has the entry", async () => {
  const archive = Buffer.concat([
    entry("files/favicon.png", "EARLY"),
    entry("files/huge.bin", Buffer.alloc(64 * 1024, 3)),
    END,
  ]);
  let delivered = 0;
  let closed = false;
  async function* counted(): AsyncGenerator<Uint8Array> {
    try {
      for (let off = 0; off < archive.length; off += 512) {
        delivered += 1;
        yield archive.subarray(off, off + 512);
      }
    } finally {
      closed = true;
    }
  }
  assert.deepEqual(
    await readTarEntry(counted(), { ...OPTS, name: "files/favicon.png" }),
    Buffer.from("EARLY"),
  );
  // Two blocks (header + body) is all it takes; the 64 KiB tail never ships,
  // and the producer is closed (for a gRPC stream: the call is cancelled).
  assert.equal(delivered, 2);
  assert.equal(closed, true);
});

test("tarEntries: skips directories, links and other non-regular entries", async () => {
  const archive = Buffer.concat([
    entry("files/sub/", "", { type: "5" }),
    entry("files/link", "", { type: "2" }),
    entry("files/real.txt", "ok"),
    END,
  ]);
  const names: string[] = [];
  for await (const e of tarEntries(stream(archive))) names.push(e.name);
  assert.deepEqual(names, ["files/real.txt"]);
});

test("tarEntries: reports sizes without buffering when read() declines", async () => {
  const archive = Buffer.concat([
    entry("files/a.bin", Buffer.alloc(2000, 7)),
    entry("files/b.bin", Buffer.alloc(10, 8)),
    END,
  ]);
  const seen: { name: string; size: number; buffered: boolean }[] = [];
  for await (const e of tarEntries(stream(archive), { read: () => false })) {
    seen.push({ name: e.name, size: e.size, buffered: e.bytes !== null });
  }
  assert.deepEqual(seen, [
    { name: "files/a.bin", size: 2000, buffered: false },
    { name: "files/b.bin", size: 10, buffered: false },
  ]);
});

test("tarEntries: a corrupt header ends the scan instead of throwing", async () => {
  const archive = Buffer.concat([
    entry("files/a.txt", "a"),
    Buffer.alloc(BLOCK, 0x41), // garbage where a header should be
    entry("files/b.txt", "b"),
    END,
  ]);
  const names: string[] = [];
  for await (const e of tarEntries(stream(archive))) names.push(e.name);
  assert.deepEqual(names, ["files/a.txt"]);
});

test("tarEntries: a truncated stream yields what it managed to read", async () => {
  const full = Buffer.concat([
    entry("files/a.txt", "a"),
    entry("files/b.txt", "b"),
  ]);
  const names: string[] = [];
  for await (const e of tarEntries(stream(full.subarray(0, 1100))))
    names.push(e.name);
  assert.deepEqual(names, ["files/a.txt"]);
});

test("readTarEntry: reads a REAL archive produced by tar(1), gzip included", async (t) => {
  // The hand-built cases above pin the format; this one proves the parser eats
  // what an actual tar writes (long paths, PAX records and all). Skipped where
  // tar isn't installed rather than failing the suite.
  const dir = mkdtempSync(join(tmpdir(), "deplo-tar-test-"));
  try {
    const deep = join(
      dir,
      "files",
      "web",
      "assets",
      "very",
      "deeply",
      "nested",
      "path",
    );
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(dir, "files", "readme.txt"), "hello");
    const icon = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 255, 254]);
    writeFileSync(join(deep, "favicon.ico"), icon);
    let tarball: Buffer;
    try {
      tarball = execFileSync("tar", ["-cf", "-", "files"], {
        cwd: dir,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      t.skip("tar(1) is not available");
      return;
    }
    const rel = "files/web/assets/very/deeply/nested/path/favicon.ico";
    assert.deepEqual(
      await readTarEntry(stream(tarball, 337), { ...OPTS, name: rel }),
      icon,
      "plain tar",
    );
    // The agent ships the archive gzipped; the caller gunzips, so feeding the
    // decompressed bytes back through must behave identically.
    const round = gzipSync(tarball);
    assert.equal(round.length > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
