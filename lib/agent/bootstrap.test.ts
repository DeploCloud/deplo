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
    allTeams: true,
    storageOnly: false,
    buildOnly: false,
    buildFallback: null,
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

// Measured on a takeover: the address in the command did not answer, curl fetched
// nothing, `| bash` ran an empty script and exited 0 - "installed" in silence.
test("the one-liners download first and run second, so a failed download fails", () => {
  const cmd = installCommand({
    baseUrl: "https://deplo.example.com",
    rawToken: "t",
    fingerprint: "f",
  });
  assert.doesNotMatch(cmd, /\| *sudo/);
  assert.match(
    cmd,
    /--output \/tmp\/deplo-agent-install\.sh && sudo bash \/tmp\/deplo-agent-install\.sh 't' 'https:\/\/deplo\.example\.com' 'f'$/,
  );
  assert.match(
    installCommand({
      baseUrl: "http://10.0.0.5:3000",
      rawToken: "t",
      fingerprint: "",
      importOnly: true,
    }),
    /&& sudo DEPLO_IMPORT_ONLY=1 bash \/tmp\/deplo-agent-install\.sh 't' 'http:\/\/10\.0\.0\.5:3000'$/,
  );
  const un = uninstallCommand({ baseUrl: "https://deplo.example.com" });
  assert.doesNotMatch(un, /\| *sudo/);
  assert.match(
    un,
    /--output \/tmp\/deplo-uninstall\.sh && sudo bash \/tmp\/deplo-uninstall\.sh --yes --agent-only$/,
  );
});

// The curl alternatives of uBlock Origin's ClickFix filter (uAssets,
// `prevent-clipboard-write` on every site, 2026-09-05). A match is a silent
// no-op copy with a "Copied" toast on top: the operator pastes nothing.
const UBO_CLICKFIX =
  /^curl -s\b.+?\| (bash|sh|zsh)\b|^curl\b .+?chmod \+x.+?&&|^curl\b.+?-o\b.+?\/tmp\/.+?&&|^(bash <<<|curl -kfsSL) \$\(echo .+? base64 -d\b/ims;

test("the one-liners do not trip uBlock Origin's ClickFix filter", () => {
  const base = {
    baseUrl: "http://10.0.0.5:3000",
    rawToken: "t",
    fingerprint: "",
  };
  assert.doesNotMatch(installCommand(base), UBO_CLICKFIX);
  assert.doesNotMatch(
    installCommand({ ...base, insecure: true, importOnly: true }),
    UBO_CLICKFIX,
  );
  assert.doesNotMatch(uninstallCommand(base), UBO_CLICKFIX);
  // The shape it exists for, so the regex above is known to bite.
  assert.match(
    "curl -fsSL 'http://x/a.sh' -o /tmp/a.sh && sudo bash /tmp/a.sh",
    UBO_CLICKFIX,
  );
});

test("curl skips verification only when the panel's own certificate does not", () => {
  // The generated nip.io address serves a certificate no public CA signed, so a
  // command without -k fetches nothing. Printing it on an instance with a real
  // certificate would teach people to skip verification for no reason.
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

test("a certificate that could not be read at all does not print -k", async () => {
  // Unknown is not untrusted: a panel behind a proxy that dropped one connection
  // would otherwise start teaching people to skip verification.
  const { controlPlaneCert } = await import("./bootstrap");
  const cert = await controlPlaneCert("http://10.255.255.1:3000");
  assert.equal(cert.insecure, false);
  assert.equal(cert.fingerprint, "");
});

test("the role rides as an env prefix INSIDE the elevated shell", () => {
  // `sudo` does not forward the caller's environment, so a prefix outside it would be
  // silently dropped and the host would install as an ordinary server - with Traefik,
  // the shared network and a rewritten daemon.json on a machine Deplo is only
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

  // Exactly one of them, ever: the three roles are exclusive, and a command
  // carrying two would leave the host's shape up to the script's branch order.
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
  // And the narrowest wins, because it is the one that touches the host least.
  assert.match(all, /DEPLO_IMPORT_ONLY=1/);

  // An ordinary server carries no prefix at all.
  assert.doesNotMatch(installCommand(base), /DEPLO_[A-Z_]+_ONLY/);
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

// The agent refuses to bootstrap against an HTTPS control plane with no pinned
// fingerprint, so a command minted without one exits 0, says the agent is calling
// home, and leaves a service restarting every five seconds.
test("an https panel whose certificate could not be read mints nothing", () => {
  assert.throws(
    () => assertPinnableFingerprint(new URL("https://panel.example.com"), ""),
    /refuses to start/,
  );
  assert.doesNotThrow(() =>
    assertPinnableFingerprint(new URL("https://panel.example.com"), "ab12"),
  );
  // Over plain http the agent uses the HMAC path, and there is nothing to pin.
  assert.doesNotThrow(() =>
    assertPinnableFingerprint(new URL("http://panel.example.com"), ""),
  );
});
