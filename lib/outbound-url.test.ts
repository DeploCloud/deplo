import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  __resetDnsLookupForTest,
  __setDnsLookupForTest,
  assertSafeOutboundUrl,
} from "./outbound-url";

/**
 * Every IPv6 spelling that stands for an internal IPv4 - v4-mapped, NAT64, 6to4,
 * Teredo - is judged as that IPv4, as a literal and as a DNS answer alike.
 */

before(() => {
  __setDnsLookupForTest(async (host) => {
    if (host === "nat64.example") return [{ address: "64:ff9b::7f00:1" }];
    if (host === "sixtofour.example") return [{ address: "2002:c0a8:101::1" }];
    return [{ address: "93.184.216.34" }];
  });
});

after(() => __resetDnsLookupForTest());

const refused = (url: string) =>
  assert.rejects(
    () => assertSafeOutboundUrl(url, "Webhook"),
    /private or internal/,
    url,
  );
const allowed = (url: string) => assertSafeOutboundUrl(url, "Webhook");

test("embedded-IPv4 forms of an internal address are refused", async () => {
  await refused("https://[::ffff:10.0.0.1]/");
  await refused("https://[::ffff:a00:1]/");
  await refused("https://[64:ff9b::7f00:1]/"); // NAT64 → 127.0.0.1
  await refused("https://[64:ff9b:1::a9fe:a9fe]/"); // NAT64 local → 169.254.169.254
  await refused("https://[2002:7f00:1::1]/"); // 6to4 → 127.0.0.1
  await refused("https://[2002:c0a8:101::]/"); // 6to4 → 192.168.1.1
  await refused("https://[2001:0:0:0:0:0:80ff:fffe]/"); // Teredo → 127.0.0.1
  await refused("https://[0:0:0:0:0:0:0:1]/");
  await refused("https://[fe80::1]/");
  await refused("https://[fd12::1]/");
});

test("a DNS answer in one of those forms is refused too", async () => {
  await refused("https://nat64.example/hook");
  await refused("https://sixtofour.example/hook");
});

test("public addresses in every spelling stay allowed", async () => {
  await allowed("https://[2606:4700::1111]/");
  await allowed("https://[2002:808:808::1]/"); // 6to4 → 8.8.8.8
  await allowed("https://[64:ff9b::808:808]/"); // NAT64 → 8.8.8.8
  await allowed("https://[::ffff:8.8.8.8]/");
  await allowed("https://example.com/hook");
});
