import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { SNIFF_HEAD_BYTES, sniffArtifact } from "./artifact-sniff";
import { looksEncrypted, looksGzip } from "./artifact-format";

/**
 * The sniffer is the last thing standing between an uploaded file and an agent
 * that stops the stack, wipes every volume and untars whatever arrives. So the
 * cases that matter here are the destructive mix-ups: the wrong kind of
 * artifact, the wrong key, and a file that is not an artifact at all.
 *
 * Everything is built in memory - a tar-shaped buffer is one with `ustar` at
 * offset 257, which is exactly what the real check reads.
 */

/** A buffer that IS a tar as far as the head check is concerned. */
function tarLike(size = 8192): Buffer {
  const buf = Buffer.alloc(size);
  buf.write("volumes/data/deplo.db", 0);
  buf.write("ustar", 257);
  return buf;
}

/** A database dump: gzip of something that is emphatically not a tar. */
function dumpLike(size = 8192): Buffer {
  const buf = Buffer.alloc(size);
  buf.write("PGDMP", 0);
  return buf;
}

/** Incompressible filler, so a gzip of it is bigger than one age chunk. */
function bulky(size: number): Buffer {
  const buf = tarLike(size);
  for (let i = 1024; i < size; i += 16)
    buf.write(i.toString(36).padEnd(15, "x"), i);
  return buf;
}

async function encrypt(
  plain: Buffer,
): Promise<{ artifact: Buffer; key: string }> {
  const age = await import("age-encryption");
  const key = await age.generateX25519Identity();
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(await age.identityToRecipient(key));
  return { artifact: Buffer.from(await encrypter.encrypt(plain)), key };
}

const APP = { kind: "app" as const, recoveryKey: "" };
const DB = { kind: "database" as const, recoveryKey: "" };

test("magic bytes: age vs gzip vs neither", () => {
  assert.equal(looksEncrypted(Buffer.from("age-encryption.org/v1\n...")), true);
  assert.equal(
    looksEncrypted(Buffer.from("age-encryption")),
    false,
    "too short",
  );
  assert.equal(looksGzip(zlib.gzipSync(Buffer.from("x"))), true);
  assert.equal(looksGzip(Buffer.from("PK\x03\x04")), false);
});

test("a plain app artifact passes and reports itself unencrypted", async () => {
  const { encrypted } = await sniffArtifact(zlib.gzipSync(tarLike()), APP);
  assert.equal(encrypted, false);
});

test("a plain database dump passes", async () => {
  const { encrypted } = await sniffArtifact(zlib.gzipSync(dumpLike()), DB);
  assert.equal(encrypted, false);
});

test("an empty file is refused before anything else", async () => {
  await assert.rejects(() => sniffArtifact(Buffer.alloc(0), APP), /is empty/);
});

test("a file that is neither age nor gzip is refused", async () => {
  await assert.rejects(
    () => sniffArtifact(Buffer.from("PK\x03\x04 this is a zip"), APP),
    /not a backup artifact/,
  );
});

test("a database dump uploaded onto an APP is refused", async () => {
  // The mix-up that would otherwise wipe every volume and restore nothing.
  await assert.rejects(
    () => sniffArtifact(zlib.gzipSync(dumpLike()), APP),
    /not an app backup/,
  );
});

test("an app archive uploaded onto a DATABASE is refused", async () => {
  await assert.rejects(
    () => sniffArtifact(zlib.gzipSync(tarLike()), DB),
    /app backup, not a database dump/,
  );
});

test("an encrypted artifact with the right key passes and says so", async () => {
  const { artifact, key } = await encrypt(zlib.gzipSync(tarLike()));
  const { encrypted } = await sniffArtifact(artifact, {
    kind: "app",
    recoveryKey: key,
  });
  assert.equal(encrypted, true);
});

test("an encrypted artifact with no key at all is refused", async () => {
  const { artifact } = await encrypt(zlib.gzipSync(tarLike()));
  await assert.rejects(
    () => sniffArtifact(artifact, APP),
    /Paste the recovery key/,
  );
});

test("a key that is not a key is told apart from a key that does not fit", async () => {
  const { artifact } = await encrypt(zlib.gzipSync(tarLike()));
  await assert.rejects(
    () => sniffArtifact(artifact, { kind: "app", recoveryKey: "hunter2" }),
    /not a recovery key/,
  );

  const other = await encrypt(Buffer.from("unrelated"));
  await assert.rejects(
    () => sniffArtifact(artifact, { kind: "app", recoveryKey: other.key }),
    /does not open this file/,
  );
});

test("a big encrypted artifact is judged from its truncated head", async () => {
  // The real shape: only the first 128 KiB ever reaches the sniffer, so the last
  // age chunk it holds is cut in half and the gzip stream ends mid-stream.
  // Neither is a failure - one whole chunk is all the tar magic needs.
  const { artifact, key } = await encrypt(
    zlib.gzipSync(bulky(4 * 1024 * 1024)),
  );
  assert.ok(
    artifact.length > SNIFF_HEAD_BYTES,
    "artifact must exceed the head",
  );
  const head = artifact.subarray(0, SNIFF_HEAD_BYTES);
  const { encrypted } = await sniffArtifact(head, {
    kind: "app",
    recoveryKey: key,
  });
  assert.equal(encrypted, true);
});

test("a head too short to hold one age chunk decrypts to nothing and is refused", async () => {
  // Not a hazard, but it must fail CLOSED: with no plaintext there is no tar
  // magic, so an app restore is refused rather than waved through.
  const { artifact, key } = await encrypt(
    zlib.gzipSync(bulky(4 * 1024 * 1024)),
  );
  await assert.rejects(
    () =>
      sniffArtifact(artifact.subarray(0, 4096), {
        kind: "app",
        recoveryKey: key,
      }),
    /not an app backup/,
  );
});

test("gzip that inflates past the cap is still judged, not swallowed", async () => {
  // 4 MiB of zeroes compress to a few KiB: the guard against a decompression
  // bomb must not also blind the tar check.
  const { encrypted } = await sniffArtifact(
    zlib.gzipSync(tarLike(4 * 1024 * 1024)),
    APP,
  );
  assert.equal(encrypted, false);
});
