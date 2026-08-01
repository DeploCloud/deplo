import { test } from "node:test";
import assert from "node:assert/strict";

import {
  nipDomain,
  randomWords,
  productionDomain,
  previewDomain,
  nipEmbeddedIp,
} from "./domains";

/**
 * The generated default-domain shape is
 * `<label>-<adjective>-<animal>-<hexip>.nip.io`: an app/slug prefix, two
 * human-readable random words, then the server IP in hex as the trailing label
 * (where nip.io expects the address). These tests pin the format and the
 * round-trip with nipEmbeddedIp; the random WORDS are exercised separately so
 * the format assertions stay deterministic.
 */

const IP = "1.2.3.4";
const HEX = "01020304";

test("nipDomain builds <label>-<words>-<hexip>.nip.io", () => {
  assert.equal(
    nipDomain("myapp", "charming-otter", IP),
    `myapp-charming-otter-${HEX}.nip.io`,
  );
});

test("nipDomain sanitises the label and words to DNS-safe segments", () => {
  // Uppercase, spaces, and stray punctuation collapse to hyphens; leading/
  // trailing hyphens are trimmed per segment.
  assert.equal(
    nipDomain("My App!", "Bold Lynx", IP),
    `my-app-bold-lynx-${HEX}.nip.io`,
  );
});

test("nipDomain output round-trips through nipEmbeddedIp", () => {
  const host = nipDomain("svc", "keen-puma", "95.135.208.208");
  assert.equal(nipEmbeddedIp(host), "95.135.208.208");
});

test("the hex IP is the LAST label before .nip.io (nip.io's hex form requirement)", () => {
  const host = nipDomain("svc", "warm-finch", IP);
  assert.ok(
    host.endsWith(`-${HEX}.nip.io`),
    `expected hex IP as the trailing label, got ${host}`,
  );
});

test("randomWords yields a hyphenated adjective-animal pair (lowercase, two parts)", () => {
  for (let i = 0; i < 25; i++) {
    const w = randomWords();
    const parts = w.split("-");
    assert.equal(parts.length, 2, `expected two words, got "${w}"`);
    assert.ok(parts.every((p) => /^[a-z]+$/.test(p)), `non-[a-z] word in "${w}"`);
  }
});

test("productionDomain bakes fresh random words for the slug", () => {
  const host = productionDomain("blog", IP);
  // Shape: blog-<word>-<word>-<hex>.nip.io
  assert.ok(
    new RegExp(`^blog-[a-z]+-[a-z]+-${HEX}\\.nip\\.io$`).test(host),
    `unexpected production domain shape: ${host}`,
  );
  assert.equal(nipEmbeddedIp(host), IP);
});

test("previewDomain folds a per-deploy token in so two previews never collide", () => {
  const a = previewDomain("blog", "a1b2c3", IP);
  const b = previewDomain("blog", "d4e5f6", IP);
  assert.ok(a.startsWith("blog-a1b2c3-"));
  assert.ok(b.startsWith("blog-d4e5f6-"));
  assert.notEqual(a, b);
  assert.equal(nipEmbeddedIp(a), IP);
});
