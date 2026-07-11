import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isCloudflareIp,
  classifyDomainDns,
  CLOUDFLARE_IPV4_RANGES,
} from "./cloudflare";

// --- isCloudflareIp: IPv4 membership in the published proxy ranges ---

test("isCloudflareIp: true for addresses inside published IPv4 ranges", () => {
  for (const ip of [
    "104.16.5.5", // 104.16.0.0/13
    "104.24.9.9", // 104.24.0.0/14 (just past the /13 above)
    "172.64.1.1", // 172.64.0.0/13
    "173.245.48.10", // 173.245.48.0/20 (first range)
    "162.158.0.1", // 162.158.0.0/15
    "198.41.128.1", // 198.41.128.0/17
    "131.0.72.1", // 131.0.72.0/22 (last range)
    "103.21.244.10", // 103.21.244.0/22
  ]) {
    assert.equal(isCloudflareIp(ip), true, `${ip} should be a Cloudflare IP`);
  }
});

test("isCloudflareIp: false for non-Cloudflare IPv4 (incl. the CF DNS resolver)", () => {
  for (const ip of [
    "8.8.8.8", // Google DNS
    "1.1.1.1", // Cloudflare's public DNS — NOT a proxy range, must be false
    "5.6.7.8", // an ordinary origin server
    "104.15.255.255", // one below 104.16.0.0/13
    "104.28.0.1", // above the 104.24.0.0/14 block, below 104.24? (not covered)
    "192.168.1.1", // private
    "203.0.113.7", // TEST-NET-3
  ]) {
    assert.equal(isCloudflareIp(ip), false, `${ip} should NOT be a Cloudflare IP`);
  }
});

test("isCloudflareIp: /13 and /14 boundaries are exact", () => {
  // 104.16.0.0/13 spans 104.16.0.0 – 104.23.255.255
  assert.equal(isCloudflareIp("104.16.0.0"), true);
  assert.equal(isCloudflareIp("104.23.255.255"), true);
  assert.equal(isCloudflareIp("104.15.255.255"), false);
  // 104.24.0.0/14 spans 104.24.0.0 – 104.27.255.255 (the /13 does NOT cover it)
  assert.equal(isCloudflareIp("104.24.0.0"), true);
  assert.equal(isCloudflareIp("104.27.255.255"), true);
  assert.equal(isCloudflareIp("104.28.0.0"), false);
});

test("isCloudflareIp: malformed input is never a Cloudflare IP", () => {
  for (const bad of ["", "not-an-ip", "999.999.999.999", "104.16", "104.16.0"]) {
    assert.equal(isCloudflareIp(bad), false, `${JSON.stringify(bad)} → false`);
  }
});

// --- isCloudflareIp: IPv6 membership ---

test("isCloudflareIp: true for addresses inside published IPv6 ranges", () => {
  for (const ip of [
    "2606:4700::1", // 2606:4700::/32
    "2400:cb00:1234::1", // 2400:cb00::/32
    "2a06:98c0:0:0:0:0:0:1", // 2a06:98c0::/29
    "2803:f800::abcd", // 2803:f800::/32
  ]) {
    assert.equal(isCloudflareIp(ip), true, `${ip} should be a Cloudflare IPv6`);
  }
});

test("isCloudflareIp: false for non-Cloudflare IPv6", () => {
  for (const ip of [
    "2001:4860:4860::8888", // Google IPv6 DNS
    "::1", // loopback
    "2607:f8b0::1", // Google
  ]) {
    assert.equal(isCloudflareIp(ip), false, `${ip} should NOT be a Cloudflare IPv6`);
  }
});

// --- classifyDomainDns: the three-way DNS verdict ---

test("classifyDomainDns: a direct A record to the server is valid", () => {
  assert.equal(classifyDomainDns(["5.6.7.8"], "5.6.7.8"), "valid");
});

test("classifyDomainDns: Cloudflare edge IPs (origin masked) are cloudflare, not misconfigured", () => {
  assert.equal(classifyDomainDns(["104.16.5.5"], "5.6.7.8"), "cloudflare");
  assert.equal(
    classifyDomainDns(["104.16.5.5", "172.64.1.1"], "5.6.7.8"),
    "cloudflare",
  );
});

test("classifyDomainDns: a direct hit wins even alongside a Cloudflare IP", () => {
  assert.equal(
    classifyDomainDns(["5.6.7.8", "104.16.5.5"], "5.6.7.8"),
    "valid",
  );
});

test("classifyDomainDns: an unrelated IP or no record is misconfigured", () => {
  assert.equal(classifyDomainDns(["9.9.9.9"], "5.6.7.8"), "misconfigured");
  assert.equal(classifyDomainDns([], "5.6.7.8"), "misconfigured");
});

// --- range list sanity ---

test("CLOUDFLARE_IPV4_RANGES mirrors the published ips-v4 list (15 CIDRs)", () => {
  assert.equal(CLOUDFLARE_IPV4_RANGES.length, 15);
  for (const cidr of CLOUDFLARE_IPV4_RANGES) {
    assert.match(cidr, /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, `${cidr} is a CIDR`);
  }
});
