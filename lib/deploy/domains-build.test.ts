import { test } from "node:test";
import assert from "node:assert/strict";

import {
  wildcardDomain,
  randomWord,
  productionDomain,
  previewHost,
  isValidPreviewBaseDomain,
  wildcardEmbeddedIp,
} from "./domains";

const IP = "1.2.3.4";
const HEX = "01020304";

test("wildcardDomain builds <label>-<word>-<hexip>.deplo.site", () => {
  assert.equal(
    wildcardDomain("myapp", "otter", IP),
    `myapp-otter-${HEX}.deplo.site`,
  );
});

test("wildcardDomain sanitises the label and words to DNS-safe segments", () => {
  assert.equal(
    wildcardDomain("My App!", "Bold Lynx", IP),
    `my-app-bold-lynx-${HEX}.deplo.site`,
  );
});

test("wildcardDomain keeps the first label inside the 63-character DNS limit", () => {
  const host = wildcardDomain(
    "analytics-production-stack-rybbit_clickhouse_worker",
    "charming-otter",
    IP,
  );
  const label = host.split(".")[0];
  assert.ok(label.length <= 63, `label is ${label.length} characters`);
  assert.ok(host.endsWith(`-charming-otter-${HEX}.deplo.site`));
  assert.ok(!label.includes("--"));
});

test("wildcardDomain output round-trips through wildcardEmbeddedIp", () => {
  const host = wildcardDomain("svc", "keen-puma", "95.135.208.208");
  assert.equal(wildcardEmbeddedIp(host), "95.135.208.208");
});

test("the hex IP is the LAST label before the zone (the wildcard's hex form)", () => {
  const host = wildcardDomain("svc", "warm-finch", IP);
  assert.ok(
    host.endsWith(`-${HEX}.deplo.site`),
    `expected hex IP as the trailing label, got ${host}`,
  );
});

test("randomWord yields one lowercase word, no dash", () => {
  for (let i = 0; i < 25; i++) {
    const w = randomWord();
    assert.match(w, /^[a-z]+$/, `expected one plain word, got "${w}"`);
  }
});

test("productionDomain bakes a fresh random word for the slug", () => {
  const host = productionDomain("blog", IP);
  assert.ok(
    new RegExp(`^blog-[a-z]+-${HEX}\\.deplo\\.site$`).test(host),
    `unexpected production domain shape: ${host}`,
  );
  assert.equal(wildcardEmbeddedIp(host), IP);
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
    new RegExp(`^blog-pr-42-[a-z0-9]+-${HEX}\\.deplo\\.site$`).test(first.host),
    `unexpected preview host shape: ${first.host}`,
  );
  assert.equal(wildcardEmbeddedIp(first.host), IP);
});

test("different apps and different pull requests get different preview hosts", () => {
  const a = previewHost({ appId: "prj_1", slug: "blog", prNumber: 42, ip: IP });
  const b = previewHost({ appId: "prj_1", slug: "blog", prNumber: 43, ip: IP });
  const c = previewHost({ appId: "prj_2", slug: "blog", prNumber: 42, ip: IP });
  assert.notEqual(a.host, b.host);
  assert.notEqual(a.host, c.host, "two apps must not share one preview host");
});

test("a generated preview host asks for NO certificate", () => {
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
