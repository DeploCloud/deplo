import { test } from "node:test";
import assert from "node:assert/strict";

import { assertSafeOutboundHost } from "../../outbound-url";
import {
  __resetDnsLookupForTest,
  __setDnsLookupForTest,
  assertSafeOutboundUrl,
} from "./create";

test("the outbound guard refuses every private-address literal", async () => {
  const bad = [
    "http://127.0.0.1/x",
    "http://localhost/x",
    "http://10.1.2.3/x",
    "http://172.16.0.9/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/x",
    "http://0177.0.0.1/x",
    "http://[::1]/x",
    "http://[fd00::1]/x",
    "http://[::ffff:127.0.0.1]/x",
  ];
  for (const url of bad) {
    await assert.rejects(
      () => assertSafeOutboundUrl(url, "Endpoint", { allowHttp: true }),
      /private or internal/,
      `${url} must be refused`,
    );
  }
});

test("a hostname is resolved, so a name pointing inside is refused too", async () => {
  __setDnsLookupForTest(async (host) =>
    host === "internal.example.com"
      ? [{ address: "10.0.0.5" }]
      : host === "split.example.com"
        ? [{ address: "93.184.216.34" }, { address: "127.0.0.1" }]
        : [{ address: "93.184.216.34" }],
  );
  try {
    await assert.rejects(
      () =>
        assertSafeOutboundUrl(
          "https://internal.example.com/hook",
          "Webhook URL",
        ),
      /private or internal/,
      "a name that answers with a private address is the same attack, spelled politely",
    );
    await assert.rejects(
      () =>
        assertSafeOutboundUrl("https://split.example.com/hook", "Webhook URL"),
      /private or internal/,
    );
    await assertSafeOutboundUrl("https://hooks.example.com/x", "Webhook URL");
    await assert.rejects(
      () => assertSafeOutboundUrl("http://hooks.example.com/x", "Webhook URL"),
      /must be an https URL/,
    );
  } finally {
    __resetDnsLookupForTest();
  }
});

test("the bare-host guard resolves non-canonical numeric IPs instead of trusting them", async () => {
  const resolved: Record<string, string> = {
    "2130706433": "127.0.0.1",
    "127.1": "127.0.0.1",
    "0177.0.0.1": "127.0.0.1",
    "2852039166": "169.254.169.254",
    "private.example.com": "10.0.0.5",
    "smtp.example.com": "93.184.216.34",
  };
  __setDnsLookupForTest(async (host) => {
    const addr = resolved[host];
    if (!addr) throw new Error("ENOTFOUND");
    return [{ address: addr }];
  });
  try {
    for (const host of [
      "2130706433",
      "127.1",
      "0177.0.0.1",
      "2852039166",
      "127.0.0.1",
      "private.example.com",
    ]) {
      await assert.rejects(
        () => assertSafeOutboundHost(host, "SMTP host"),
        /private or internal/,
        `${host} must be refused`,
      );
    }
    await assertSafeOutboundHost("smtp.example.com", "SMTP host");
  } finally {
    __resetDnsLookupForTest();
  }
});

test("the bare-host guard canonicalizes non-canonical IPv6 literals too", async () => {
  __setDnsLookupForTest(async (host) => {
    if (host === "smtp.example.com") return [{ address: "93.184.216.34" }];
    throw new Error("ENOTFOUND");
  });
  try {
    for (const host of [
      "0:0:0:0:0:0:0:1",
      "0000:0000:0000:0000:0000:0000:0000:0001",
      "[::1]",
      "::1",
      "0:0:0:0:0:ffff:7f00:1",
      "fe80:0:0:0:0:0:0:1",
      "fc00:0:0:0:0:0:0:1",
    ]) {
      await assert.rejects(
        () => assertSafeOutboundHost(host, "SMTP host"),
        /private or internal/,
        `${host} must be refused`,
      );
    }
    await assertSafeOutboundHost("2606:4700:4700::1111", "SMTP host");
  } finally {
    __resetDnsLookupForTest();
  }
});

test("the bare-host guard refuses a zone-id literal and reads NAT64's embedded IPv4", async () => {
  __setDnsLookupForTest(async (host) => {
    if (host === "smtp.example.com") return [{ address: "93.184.216.34" }];
    throw new Error("ENOTFOUND");
  });
  try {
    for (const host of [
      "::1%eth0",
      "0:0:0:0:0:0:0:1%eth0",
      "fe80::1%eth0",
      "64:ff9b::7f00:1",
      "64:ff9b::a00:5",
    ]) {
      await assert.rejects(
        () => assertSafeOutboundHost(host, "SMTP host"),
        /private or internal/,
        `${host} must be refused`,
      );
    }
    await assertSafeOutboundHost("64:ff9b::5db8:d822", "SMTP host");
  } finally {
    __resetDnsLookupForTest();
  }
});

test("a name that doesn't resolve is left alone, not refused", async () => {
  __setDnsLookupForTest(async () => {
    throw new Error("ENOTFOUND");
  });
  try {
    await assertSafeOutboundUrl("https://maybe.example.com/x", "Webhook URL");
  } finally {
    __resetDnsLookupForTest();
  }
});
