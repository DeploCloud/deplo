import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isCloudflareIp,
  classifyDnsRecords,
  certProviderForDns,
  isProxiedDomain,
  isRoutableDomain,
  CLOUDFLARE_IPV4_RANGES,
} from "./cloudflare";

test("isCloudflareIp: true for addresses inside published IPv4 ranges", () => {
  for (const ip of [
    "104.16.5.5",
    "104.24.9.9",
    "172.64.1.1",
    "173.245.48.10",
    "162.158.0.1",
    "198.41.128.1",
    "131.0.72.1",
    "103.21.244.10",
  ]) {
    assert.equal(isCloudflareIp(ip), true, `${ip} should be a Cloudflare IP`);
  }
});

test("isCloudflareIp: false for non-Cloudflare IPv4 (incl. the CF DNS resolver)", () => {
  for (const ip of [
    "8.8.8.8",
    "1.1.1.1",
    "5.6.7.8",
    "104.15.255.255",
    "104.28.0.1",
    "192.168.1.1",
    "203.0.113.7",
  ]) {
    assert.equal(
      isCloudflareIp(ip),
      false,
      `${ip} should NOT be a Cloudflare IP`,
    );
  }
});

test("isCloudflareIp: /13 and /14 boundaries are exact", () => {
  assert.equal(isCloudflareIp("104.16.0.0"), true);
  assert.equal(isCloudflareIp("104.23.255.255"), true);
  assert.equal(isCloudflareIp("104.15.255.255"), false);
  assert.equal(isCloudflareIp("104.24.0.0"), true);
  assert.equal(isCloudflareIp("104.27.255.255"), true);
  assert.equal(isCloudflareIp("104.28.0.0"), false);
});

test("isCloudflareIp: malformed input is never a Cloudflare IP", () => {
  for (const bad of [
    "",
    "not-an-ip",
    "999.999.999.999",
    "104.16",
    "104.16.0",
  ]) {
    assert.equal(isCloudflareIp(bad), false, `${JSON.stringify(bad)} → false`);
  }
});

test("isCloudflareIp: true for addresses inside published IPv6 ranges", () => {
  for (const ip of [
    "2606:4700::1",
    "2400:cb00:1234::1",
    "2a06:98c0:0:0:0:0:0:1",
    "2803:f800::abcd",
  ]) {
    assert.equal(isCloudflareIp(ip), true, `${ip} should be a Cloudflare IPv6`);
  }
});

test("isCloudflareIp: false for non-Cloudflare IPv6", () => {
  for (const ip of ["2001:4860:4860::8888", "::1", "2607:f8b0::1"]) {
    assert.equal(
      isCloudflareIp(ip),
      false,
      `${ip} should NOT be a Cloudflare IPv6`,
    );
  }
});

const SERVER = { v4: ["5.6.7.8"], v6: ["2001:db8::1"], v6Known: true };
const V6_UNKNOWN = { v4: ["5.6.7.8"], v6: [], v6Known: false };
const status = (a: string[], aaaa: string[] = [], t = SERVER) =>
  classifyDnsRecords({ a, aaaa }, t).status;

test("classifyDnsRecords: a direct A record to the server is valid", () => {
  assert.equal(status(["5.6.7.8"]), "valid");
});

test("classifyDnsRecords: Cloudflare edge IPs (origin masked) are cloudflare, not misconfigured", () => {
  assert.equal(status(["104.16.5.5"]), "cloudflare");
  assert.equal(status(["104.16.5.5", "172.64.1.1"]), "cloudflare");
  assert.equal(status(["104.16.5.5"], ["2606:4700::6810:1"]), "cloudflare");
});

test("classifyDnsRecords: a direct hit wins even alongside a Cloudflare IP", () => {
  assert.equal(status(["5.6.7.8", "104.16.5.5"]), "valid");
});

test("classifyDnsRecords: an unrelated IP or no record is misconfigured, and names the record", () => {
  assert.deepEqual(classifyDnsRecords({ a: ["9.9.9.9"], aaaa: [] }, SERVER), {
    status: "misconfigured",
    stray: { type: "A", address: "9.9.9.9" },
  });
  assert.equal(status([]), "misconfigured");
});

test("classifyDnsRecords: an AAAA here with no A is valid", () => {
  assert.equal(status([], ["2001:db8::1"]), "valid");
});

test("classifyDnsRecords: a right A beside an AAAA elsewhere is misconfigured, naming the AAAA", () => {
  assert.deepEqual(
    classifyDnsRecords({ a: ["5.6.7.8"], aaaa: ["2001:db8::99"] }, SERVER),
    {
      status: "misconfigured",
      stray: { type: "AAAA", address: "2001:db8::99" },
    },
  );
});

test("classifyDnsRecords: an AAAA is not judged while the server's IPv6 is unknown", () => {
  assert.equal(status(["5.6.7.8"], ["2001:db8::99"], V6_UNKNOWN), "valid");
});

test("classifyDnsRecords: an AAAA here beside an A elsewhere is misconfigured, naming the A", () => {
  assert.deepEqual(
    classifyDnsRecords({ a: ["9.9.9.9"], aaaa: ["2001:db8::1"] }, SERVER).stray,
    { type: "A", address: "9.9.9.9" },
  );
});

test("classifyDnsRecords: with no known IPv4, an A record is not judged either way", () => {
  const v6Only = { v4: [], v6: ["2001:db8::1"], v6Known: true };
  assert.equal(status(["9.9.9.9"], ["2001:db8::1"], v6Only), "valid");
  assert.deepEqual(classifyDnsRecords({ a: ["9.9.9.9"], aaaa: [] }, v6Only), {
    status: "misconfigured",
    stray: null,
  });
});

test("certProviderForDns: a proxied, cert-less domain moves onto cloudflare", () => {
  assert.equal(certProviderForDns("cloudflare", "none"), "cloudflare");
});

test("certProviderForDns: every other status leaves a cert-less domain alone", () => {
  for (const status of [
    "valid",
    "pending",
    "misconfigured",
    "error",
  ] as const) {
    assert.equal(
      certProviderForDns(status, "none"),
      "none",
      `${status} must not opt a domain into a certificate`,
    );
  }
});

test("certProviderForDns: an explicit provider is never overruled", () => {
  assert.equal(certProviderForDns("cloudflare", "letsencrypt"), "letsencrypt");
  assert.equal(certProviderForDns("cloudflare", "cloudflare"), "cloudflare");
  assert.equal(certProviderForDns("cloudflare", undefined), undefined);
});

test("certProviderForDns: un-proxying a domain does NOT strip its certificate", () => {
  assert.equal(certProviderForDns("valid", "cloudflare"), "cloudflare");
  assert.equal(certProviderForDns("misconfigured", "cloudflare"), "cloudflare");
});

test("CLOUDFLARE_IPV4_RANGES mirrors the published ips-v4 list (15 CIDRs)", () => {
  assert.equal(CLOUDFLARE_IPV4_RANGES.length, 15);
  for (const cidr of CLOUDFLARE_IPV4_RANGES) {
    assert.match(cidr, /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, `${cidr} is a CIDR`);
  }
});

test("isRoutableDomain: valid and Cloudflare-proxied hosts route", () => {
  assert.equal(isRoutableDomain({ status: "valid" }), true);
  assert.equal(isRoutableDomain({ status: "cloudflare" }), true);
});

test("isRoutableDomain: a declared proxy routes what DNS calls misconfigured", () => {
  assert.equal(isRoutableDomain({ status: "misconfigured" }), false);
  assert.equal(
    isRoutableDomain({ status: "misconfigured", proxied: true }),
    true,
  );
  assert.equal(isRoutableDomain({ status: "pending" }), false);
  assert.equal(isRoutableDomain({ status: "pending", proxied: true }), true);
});

test("isProxiedDomain: detected or declared, never inferred from `valid`", () => {
  assert.equal(isProxiedDomain({ status: "cloudflare" }), true);
  assert.equal(
    isProxiedDomain({ status: "misconfigured", proxied: true }),
    true,
  );
  assert.equal(isProxiedDomain({ status: "valid" }), false);
  assert.equal(isProxiedDomain({ status: "valid", proxied: null }), false);
});
