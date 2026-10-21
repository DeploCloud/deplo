import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DEPLO_SECRET = "test-secret-for-bootstrap-aaaaaaaaaaaaaaaa";

import {
  mintBootstrap,
  installCommand,
  uninstallCommand,
  findServerForToken,
  signResponse,
  verifyResponse,
  assertPinnableFingerprint,
  BootstrapError,
  publicKeyPin,
} from "./bootstrap";
import { X509Certificate } from "node:crypto";
import { sha256Hex } from "../crypto";
import type { Server } from "../types/server";

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
    allTeams: true,
    storageOnly: false,
    buildOnly: false,
    buildFallback: null,
    generatedAddressFamily: null,
    importOnly: false,
    uninstallPending: false,
    uninstallError: "",
    hostArch: "amd64",
    deployConcurrency: 1,
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

test("the token reaches the installer on stdin, never on a command line", () => {
  const cmd = installCommand({
    baseUrl: "https://deplo.example.com",
    rawToken: "tok123",
    fingerprint: "abcd",
    importOnly: true,
  });
  const [before, after] = cmd.split(" | sudo ");
  assert.match(before, / && echo 'tok123'$/);
  assert.doesNotMatch(after, /tok123/, "sudo's argv is world-readable");
  assert.match(after, /deplo-agent-install\.sh - 'https:/);
});

test("the one-liners download first and run second, so a failed download fails", () => {
  const cmd = installCommand({
    baseUrl: "https://deplo.example.com",
    rawToken: "t",
    fingerprint: "f",
  });
  assert.doesNotMatch(cmd, /curl[^&]*\|/, "the download is never piped");
  assert.match(
    cmd,
    /--output \/tmp\/deplo-agent-install\.sh && echo 't' \| sudo bash \/tmp\/deplo-agent-install\.sh - 'https:\/\/deplo\.example\.com' 'f'$/,
  );
  assert.match(
    installCommand({
      baseUrl: "http://10.0.0.5:3000",
      rawToken: "t",
      fingerprint: "",
      importOnly: true,
    }),
    /\| sudo DEPLO_IMPORT_ONLY=1 bash \/tmp\/deplo-agent-install\.sh - 'http:\/\/10\.0\.0\.5:3000'$/,
  );
  const un = uninstallCommand({ baseUrl: "https://deplo.example.com" });
  assert.doesNotMatch(un, /\| *sudo/);
  assert.match(
    un,
    /--output \/tmp\/deplo-uninstall\.sh && sudo bash \/tmp\/deplo-uninstall\.sh --yes --agent-only$/,
  );
});

const UBO_CLICKFIX =
  /^curl -s\b[\s\S]+?\| (bash|sh|zsh)\b|^curl\b [\s\S]+?chmod \+x[\s\S]+?&&|^curl\b[\s\S]+?-o\b[\s\S]+?\/tmp\/[\s\S]+?&&|^(bash <<<|curl -kfsSL) \$\(echo [\s\S]+? base64 -d\b/im;

test("the one-liners do not trip uBlock Origin's ClickFix filter", () => {
  const base = {
    baseUrl: "http://10.0.0.5:3000",
    rawToken: "t",
    fingerprint: "",
  };
  assert.doesNotMatch(installCommand(base), UBO_CLICKFIX);
  assert.doesNotMatch(
    installCommand({ ...base, insecure: true, importOnly: true, pin: "k=" }),
    UBO_CLICKFIX,
  );
  assert.doesNotMatch(uninstallCommand(base), UBO_CLICKFIX);
  assert.match(
    "curl -fsSL 'http://x/a.sh' -o /tmp/a.sh && sudo bash /tmp/a.sh",
    UBO_CLICKFIX,
  );
});

test("curl skips verification only when the panel's own certificate does not", () => {
  const base = {
    baseUrl: "https://deplo.example.com",
    rawToken: "t",
    fingerprint: "f",
  };
  assert.match(installCommand(base), /curl -fsSL '/);
  assert.match(installCommand({ ...base, insecure: true }), /curl -fsSLk '/);
  assert.match(
    uninstallCommand({ baseUrl: base.baseUrl, insecure: true }),
    /curl -fsSLk '/,
  );
  assert.match(uninstallCommand({ baseUrl: base.baseUrl }), /curl -fsSL '/);
});

test("an unverified panel is still pinned to its own key", () => {
  const base = {
    baseUrl: "https://deplo.example.com",
    rawToken: "t",
    fingerprint: "f",
    insecure: true,
    pin: "GCWw5Liokcs90teMKyhiUcgu1IPua9uiJODt79FJBtM=",
  };
  const pinned =
    /^curl -fsSLk --pinnedpubkey 'sha256\/\/GCWw5Liokcs90teMKyhiUcgu1IPua9uiJODt79FJBtM=' '/;
  assert.match(installCommand(base), pinned);
  assert.match(uninstallCommand(base), pinned);
  assert.doesNotMatch(
    installCommand({ ...base, insecure: false }),
    /pinnedpubkey/,
    "a CA-verified panel keeps renewing its certificate freely",
  );
});

// Generated with openssl; the pin is curl's own recipe (pkey -pubin -outform der | dgst -sha256 | base64).
const EC_CERT = `-----BEGIN CERTIFICATE-----
MIIBiTCCAS+gAwIBAgIUDDklr/F3rQl+8SS87U5IKdOJ4gswCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOZGVwbG8tcGluLXRlc3QwIBcNMjYxMDE0MjIxMjQ0WhgPMjEy
NjA5MjAyMjEyNDRaMBkxFzAVBgNVBAMMDmRlcGxvLXBpbi10ZXN0MFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEBgLlAYMMHnPoG3j4jI+ijYyhnKbxbV8cJMmpOmmL
ZiUuTqfgyht4I+5ZPuP/o8lGFAQr2cwkFKU/rECp0XuHbKNTMFEwHQYDVR0OBBYE
FDib0cm+XDvTtNeq3qR+ZqBqxJlPMB8GA1UdIwQYMBaAFDib0cm+XDvTtNeq3qR+
ZqBqxJlPMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgbyrFLRxw
eWNggr2AKO5iv09xP29KMH3spXot/p+CbYYCIQCKRdxojjbBpLA5Pl7dYwx9qmqM
9nKAhdKyD0wgdVIkLA==
-----END CERTIFICATE-----`;

test("publicKeyPin is the hash curl compares, for an EC key too", () => {
  assert.equal(
    publicKeyPin(new X509Certificate(EC_CERT).raw),
    "GCWw5Liokcs90teMKyhiUcgu1IPua9uiJODt79FJBtM=",
  );
  assert.equal(publicKeyPin(Buffer.from("not a certificate")), "");
});

test("a certificate that could not be read at all does not print -k", async () => {
  const { controlPlaneCert } = await import("./bootstrap");
  const cert = await controlPlaneCert("http://10.255.255.1:3000");
  assert.equal(cert.insecure, false);
  assert.equal(cert.fingerprint, "");
});

test("the role rides as an env prefix INSIDE the elevated shell", () => {
  const base = {
    baseUrl: "https://deplo.example.com",
    rawToken: "tok123",
    fingerprint: "",
  };
  const cases = [
    [{ ...base, storageOnly: true }, "DEPLO_STORAGE_ONLY=1"],
    [{ ...base, buildOnly: true }, "DEPLO_BUILD_ONLY=1"],
    [{ ...base, importOnly: true }, "DEPLO_IMPORT_ONLY=1"],
  ] as const;
  for (const [opts, env] of cases) {
    const cmd = installCommand(opts);
    assert.match(
      cmd,
      new RegExp(`sudo ${env} bash`),
      `${env} is not inside the sudo`,
    );
  }

  const all = installCommand({
    ...base,
    storageOnly: true,
    buildOnly: true,
    importOnly: true,
  });
  assert.equal(
    (all.match(/DEPLO_[A-Z_]+_ONLY=1/g) ?? []).length,
    1,
    "more than one role flag reached the command",
  );
  assert.match(all, /DEPLO_IMPORT_ONLY=1/);

  assert.doesNotMatch(installCommand(base), /DEPLO_[A-Z_]+_ONLY/);
});

test("findServerForToken: matches by hash and validates state", () => {
  const { rawToken, stored } = mintBootstrap();
  const server = provisioningServer({ bootstrap: stored });
  assert.equal(findServerForToken([server], rawToken).id, server.id);

  assert.throws(
    () => findServerForToken([server], "not-the-token"),
    (e: unknown) => e instanceof BootstrapError && e.reason === "unknown-token",
  );

  const used = provisioningServer({
    bootstrap: { ...stored, usedAt: new Date().toISOString() },
  });
  assert.throws(
    () => findServerForToken([used], rawToken),
    (e: unknown) => e instanceof BootstrapError && e.reason === "already-used",
  );

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
  assert.equal(verifyResponse("other-token", body, mac), false);
  assert.equal(verifyResponse(token, body + "x", mac), false);
});

test("an https panel whose certificate could not be read mints nothing", () => {
  assert.throws(
    () => assertPinnableFingerprint(new URL("https://panel.example.com"), ""),
    /refuses to start/,
  );
  assert.doesNotThrow(() =>
    assertPinnableFingerprint(new URL("https://panel.example.com"), "ab12"),
  );
  assert.doesNotThrow(() =>
    assertPinnableFingerprint(new URL("http://panel.example.com"), ""),
  );
});
