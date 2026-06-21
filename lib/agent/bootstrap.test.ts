import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DEPLO_SECRET = "test-secret-for-bootstrap-aaaaaaaaaaaaaaaa";

import {
  mintBootstrap,
  installCommand,
  findServerForToken,
  signResponse,
  verifyResponse,
  BootstrapError,
} from "./bootstrap";
import { sha256Hex } from "../crypto";
import type { Server } from "../types";

function provisioningServer(over: Partial<Server> = {}): Server {
  const { stored } = mintBootstrap();
  return {
    id: "srv_test",
    name: "edge",
    host: "203.0.113.9",
    type: "remote",
    status: "provisioning",
    ip: "203.0.113.9",
    dockerVersion: "",
    traefikEnabled: false,
    cpuCores: 0,
    memoryMb: 0,
    diskGb: 0,
    cpuUsage: 0,
    memoryUsage: 0,
    diskUsage: 0,
    createdAt: new Date("2020-01-01").toISOString(),
    bootstrap: stored,
    ...over,
  };
}

test("mintBootstrap stores only the token hash, never the raw token", () => {
  const { rawToken, stored } = mintBootstrap();
  assert.equal(stored.tokenHash, sha256Hex(rawToken));
  assert.notEqual(stored.tokenHash, rawToken);
  assert.equal(stored.usedAt, null);
  assert.ok(new Date(stored.expiresAt).getTime() > Date.now());
});

test("installCommand embeds the token + url, and the fingerprint only over HTTPS", () => {
  const withFp = installCommand({
    baseUrl: "https://deplo.example.com",
    rawToken: "tok123",
    fingerprint: "abcd",
  });
  assert.match(withFp, /install-agent\.sh/);
  assert.match(withFp, /'tok123'/);
  assert.match(withFp, /'https:\/\/deplo\.example\.com'/);
  assert.match(withFp, /'abcd'/);

  const noFp = installCommand({
    baseUrl: "http://10.0.0.5:3000",
    rawToken: "tok123",
    fingerprint: "",
  });
  assert.doesNotMatch(noFp, /'abcd'/);
  assert.match(noFp, /'http:\/\/10\.0\.0\.5:3000'/);
});

test("findServerForToken: matches by hash and validates state", () => {
  const { rawToken, stored } = mintBootstrap();
  const server = provisioningServer({ bootstrap: stored });
  assert.equal(findServerForToken([server], rawToken).id, server.id);

  // Unknown token.
  assert.throws(
    () => findServerForToken([server], "not-the-token"),
    (e: unknown) => e instanceof BootstrapError && e.reason === "unknown-token",
  );

  // Used token.
  const used = provisioningServer({
    bootstrap: { ...stored, usedAt: new Date().toISOString() },
  });
  assert.throws(
    () => findServerForToken([used], rawToken),
    (e: unknown) => e instanceof BootstrapError && e.reason === "already-used",
  );

  // Expired token.
  const expired = provisioningServer({
    bootstrap: {
      ...stored,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  assert.throws(
    () => findServerForToken([expired], rawToken),
    (e: unknown) => e instanceof BootstrapError && e.reason === "expired-token",
  );
});

test("signResponse/verifyResponse: a response binds to the token (HTTP trust path)", () => {
  const token = "high-entropy-token";
  const body = JSON.stringify({ caPem: "...", certPem: "..." });
  const mac = signResponse(token, body);
  assert.equal(verifyResponse(token, body, mac), true);
  // A different token can't reproduce the MAC (a MITM without the token).
  assert.equal(verifyResponse("other-token", body, mac), false);
  // A tampered body fails.
  assert.equal(verifyResponse(token, body + "x", mac), false);
});
