import { test } from "node:test";
import assert from "node:assert/strict";

import {
  nipDomain,
  randomWords,
  productionDomain,
  previewHost,
  isValidPreviewBaseDomain,
  nipEmbeddedIp,
} from "./domains";

const IP = "1.2.3.4";
const HEX = "01020304";

test("nipDomain builds <label>-<words>-<hexip>.nip.io", () => {
  assert.equal(
    nipDomain("myapp", "charming-otter", IP),
    `myapp-charming-otter-${HEX}.nip.io`,
  );
});

test("nipDomain sanitises the label and words to DNS-safe segments", () => {
  assert.equal(
    nipDomain("My App!", "Bold Lynx", IP),
    `my-app-bold-lynx-${HEX}.nip.io`,
  );
});

test("nipDomain keeps the first label inside the 63-character DNS limit", () => {
  const host = nipDomain(
    "analytics-production-stack-rybbit_clickhouse_worker",
    "charming-otter",
    IP,
  );
  const label = host.split(".")[0];
  assert.ok(label.length <= 63, `label is ${label.length} characters`);
  assert.ok(host.endsWith(`-charming-otter-${HEX}.nip.io`));
  assert.ok(!label.includes("--"));
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
    assert.ok(
      parts.every((p) => /^[a-z]+$/.test(p)),
      `non-[a-z] word in "${w}"`,
    );
  }
});

test("productionDomain bakes fresh random words for the slug", () => {
  const host = productionDomain("blog", IP);
  assert.ok(
    new RegExp(`^blog-[a-z]+-[a-z]+-${HEX}\\.nip\\.io$`).test(host),
    `unexpected production domain shape: ${host}`,
  );
  assert.equal(nipEmbeddedIp(host), IP);
});

test("a preview host is DETERMINISTIC per (app, pull request)", () => {
  const first = previewHost({
    appId: "prj_1",
    slug: "blog",
    prNumber: 42,
    ip: IP,
  });
  const again = previewHost({
    appId: "prj_1",
    slug: "blog",
    prNumber: 42,
    ip: IP,
  });
  assert.deepEqual(first, again);
  assert.ok(
    new RegExp(`^blog-pr-42-[a-z0-9]+-${HEX}\\.nip\\.io$`).test(first.host),
    `unexpected preview host shape: ${first.host}`,
  );
  assert.equal(nipEmbeddedIp(first.host), IP);
});

test("different apps and different pull requests get different preview hosts", () => {
  const a = previewHost({ appId: "prj_1", slug: "blog", prNumber: 42, ip: IP });
  const b = previewHost({ appId: "prj_1", slug: "blog", prNumber: 43, ip: IP });
  const c = previewHost({ appId: "prj_2", slug: "blog", prNumber: 42, ip: IP });
  assert.notEqual(a.host, b.host);
  assert.notEqual(a.host, c.host, "two apps must not share one preview host");
});

test("a nip.io preview host asks for NO certificate", () => {
  assert.equal(
    previewHost({ appId: "prj_1", slug: "blog", prNumber: 42, ip: IP })
      .certProvider,
    "none",
  );
});

test("a custom base domain gives each preview its own HTTP-01 certificate", () => {
  const r = previewHost({
    appId: "prj_1",
    slug: "blog",
    prNumber: 42,
    baseDomain: "preview.example.com",
    ip: IP,
  });
  assert.equal(r.host, "blog-pr-42.preview.example.com");
  assert.equal(r.certProvider, "letsencrypt");
  const other = previewHost({
    appId: "prj_2",
    slug: "shop",
    prNumber: 42,
    baseDomain: "preview.example.com",
    ip: IP,
  });
  assert.notEqual(r.host, other.host);
});

test("leading and trailing dots on a base domain are tolerated", () => {
  assert.equal(
    previewHost({
      appId: "a",
      slug: "blog",
      prNumber: 1,
      baseDomain: ".preview.example.com.",
    }).host,
    "blog-pr-1.preview.example.com",
  );
});

test("a preview base domain must be a plain dotted hostname", () => {
  assert.equal(isValidPreviewBaseDomain("preview.example.com"), true);
  assert.equal(isValidPreviewBaseDomain("Preview.Example.COM"), true);
  assert.equal(isValidPreviewBaseDomain("example.com"), true);
  assert.equal(
    isValidPreviewBaseDomain("localhost"),
    false,
    "a bare label is never meant",
  );
  assert.equal(isValidPreviewBaseDomain(""), false);
  assert.equal(isValidPreviewBaseDomain("has space.com"), false);
  assert.equal(isValidPreviewBaseDomain("*.example.com"), false);
  assert.equal(isValidPreviewBaseDomain("bad_underscore.com"), false);
  assert.equal(isValidPreviewBaseDomain("-lead.example.com"), false);
});
