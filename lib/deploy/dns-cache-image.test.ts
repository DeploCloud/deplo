import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const agentScript = () =>
  readFileSync(join(process.cwd(), "install-agent.sh"), "utf8");

test("install-agent.sh pins the DNS cache image, not a floating tag", () => {
  const text = agentScript();
  assert.match(text, /image="coredns\/coredns:1\.15\.0"/);
  assert.doesNotMatch(text, /coredns\/coredns:(latest|edge)\b/);
});

test("the cache binds its dedicated non-loopback address", () => {
  const text = agentScript();
  // Docker discards a loopback-only /etc/resolv.conf for containers (they fall
  // back to 8.8.8.8 and bypass the cache), so the bind IP must be routable.
  assert.match(text, /ip="10\.201\.0\.1"/);
  assert.doesNotMatch(text, /ip="127\./);
});

test("the upstream capture excludes the cache IP and loopback", () => {
  // Never forward the cache to itself: the captured resolvers drop 10.201.0.1
  // and loopback before they become CoreDNS's forward list.
  assert.ok(
    agentScript().includes("grep -vE '^(10\\.201\\.0\\.1|127\\.|::1)'"),
  );
});
