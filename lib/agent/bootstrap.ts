import "server-only";

// https://deplo.build/docs/operations/servers/add-a-server

import { connect as tlsConnect } from "node:tls";
import { createHmac, timingSafeEqual } from "node:crypto";
import { randomToken, sha256Hex } from "../crypto";
import { signAgentCsr, type SignedAgentCert } from "./pki";
import type { Server } from "../types/server";
import { PUBLIC_URL_PLACEHOLDER } from "../public-url";
import { isTestEnv } from "../db/pg";

// Bootstrap is call-home, never an outbound SSH-in: the control plane never holds a server's root key (ADR-0003).

// The agent's gRPC listener port the control plane will dial after bootstrap.
export const DEFAULT_AGENT_PORT = 9443;

const BOOTSTRAP_TTL_MS = 60 * 60_000;

// A freshly minted bootstrap secret: the raw token (shown once) + what to store.
export interface MintedBootstrap {
  // The raw one-time token - embedded in the install command, never stored.
  rawToken: string;
  // sha256 of the token + its expiry - the only things persisted on the Server row.
  stored: { tokenHash: string; expiresAt: string; usedAt: null };
}

// Mint a one-time bootstrap secret for a provisioning server.
export function mintBootstrap(): MintedBootstrap {
  const rawToken = randomToken(32);
  return { rawToken, stored: storedBootstrapFor(rawToken) };
}

// The stored half of a bootstrap for a token the caller ALREADY holds, not one minted here.
export function storedBootstrapFor(
  rawToken: string,
): MintedBootstrap["stored"] {
  return {
    tokenHash: sha256Hex(rawToken),
    expiresAt: new Date(Date.now() + BOOTSTRAP_TTL_MS).toISOString(),
    usedAt: null,
  };
}

// Build the paste-on-the-server install command; the fingerprint lets the agent pin the control plane before it sends the token.
export function installCommand(opts: {
  baseUrl: string;
  rawToken: string;
  // sha256 cert fingerprint of the control plane's TLS cert, or "" for HTTP.
  fingerprint: string;
  // True when curl cannot verify the panel's certificate; the bootstrap itself still pins the fingerprint.
  insecure?: boolean;
  // Only HOLDS BACKUPS: no Docker, no Traefik, no address pools, and a systemd unit with no `docker` group (absent there, it would refuse to start).
  storageOnly?: boolean;
  // Only BUILDS: Docker and the address pools exactly as usual, but no Traefik.
  buildOnly?: boolean;
  // Registered only to IMPORT from another platform: Docker is already there and never installed, no pools, no Traefik, no `deplo` network.
  importOnly?: boolean;
}): string {
  const {
    baseUrl,
    rawToken,
    fingerprint,
    insecure,
    storageOnly,
    buildOnly,
    importOnly,
  } = opts;
  // Argument order <token> <url> [fingerprint] is the install script's contract; single-quoted so the shell takes them literally.
  const fp = fingerprint ? ` '${fingerprint}'` : "";
  // `sudo` drops the caller's environment, so the variable is set INSIDE the elevated shell - outside it, a normal agent installs silently.
  const env = importOnly
    ? "DEPLO_IMPORT_ONLY=1 "
    : storageOnly
      ? "DEPLO_STORAGE_ONLY=1 "
      : buildOnly
        ? "DEPLO_BUILD_ONLY=1 "
        : "";
  // Download THEN run, never `curl | bash`: a failed download hands bash an empty script, which exits 0 and installs nothing silently.
  // `--output`, not `-o`: uBlock Origin's ClickFix filter drops a clipboard write matching `curl … -o … /tmp/ … &&`.
  return `curl -${curlFlags(insecure)} '${baseUrl}/install-agent.sh' --output /tmp/deplo-agent-install.sh && sudo ${env}bash /tmp/deplo-agent-install.sh '${rawToken}' '${baseUrl}'${fp}`;
}

// Build the paste-on-the-server UNINSTALL command, the counterpart to installCommand.
export function uninstallCommand(opts: {
  baseUrl: string;
  insecure?: boolean;
}): string {
  return `curl -${curlFlags(opts.insecure)} '${opts.baseUrl}/uninstall.sh' --output /tmp/deplo-uninstall.sh && sudo bash /tmp/deplo-uninstall.sh --yes --agent-only`;
}

// `-k` only when the panel's own cert does not verify (the generated nip.io host); printing it always teaches people to skip verification.
function curlFlags(insecure?: boolean): string {
  return insecure ? "fsSLk" : "fsSL";
}

// Read the sha256 fingerprint of the cert the public URL serves: empty over HTTP (the agent's HMAC path), and over HTTPS it throws rather than answer empty.
export async function controlPlaneCert(
  baseUrl: string,
): Promise<ControlPlaneCert> {
  const none = { fingerprint: "", insecure: false };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return none;
  }
  if (url.protocol !== "https:") return none;
  // The instance does not know its own address yet: a different problem from a cert that cannot be read, with its own answer.
  if (baseUrl.replace(/\/+$/, "") === PUBLIC_URL_PLACEHOLDER) return none;
  // Retried once: this dials Deplo's own public address, which can sit behind a proxy that drops a connection now and then.
  const first = await readCert(url);
  const cert = first.fingerprint ? first : await readCert(url);
  // Nothing is dialable from a test worker, so every server a test registers would fail on an address that does not exist.
  if (!isTestEnv()) assertPinnableFingerprint(url, cert.fingerprint);
  return cert;
}

// The agent will not bootstrap against HTTPS without a pinned fingerprint: an empty one leaves a restart loop behind a command that exited 0.
export function assertPinnableFingerprint(url: URL, fingerprint: string): void {
  if (url.protocol !== "https:" || fingerprint) return;
  throw new Error(
    `Deplo could not read the certificate its own address (${url.origin}) serves, so the install command would produce an agent that refuses to start. Check that ${url.hostname} answers on port ${url.port || 443} from this machine, then try again.`,
  );
}

// What one handshake with the panel's own address tells us.
export type ControlPlaneCert = {
  // sha256 of the presented certificate, or "" when it could not be read.
  fingerprint: string;
  // True only when a cert was READ and a stock CA bundle rejected it; a failed handshake stays false, since unknown must not print `-k`.
  insecure: boolean;
};

function readCert(url: URL): Promise<ControlPlaneCert> {
  const port = url.port ? Number(url.port) : 443;
  return new Promise<ControlPlaneCert>((resolve) => {
    const sock = tlsConnect(
      {
        host: url.hostname,
        port,
        servername: url.hostname,
        // Reading the cert, not authenticating (the agent pins): self-signed-on-IP is supported, and `authorized` still says what a stock client would decide.
        rejectUnauthorized: false,
        timeout: 5_000,
      },
      () => {
        const cert = sock.getPeerCertificate();
        const authorized = sock.authorized;
        sock.end();
        const fingerprint = cert?.fingerprint256
          ? cert.fingerprint256.replace(/:/g, "").toLowerCase()
          : "";
        resolve({ fingerprint, insecure: !!fingerprint && !authorized });
      },
    );
    const nothing = { fingerprint: "", insecure: false };
    sock.on("error", () => resolve(nothing));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(nothing);
    });
  });
}

// Why a bootstrap attempt was rejected - surfaced to the agent + the log.
export type BootstrapRejection =
  "unknown-token" | "expired-token" | "already-used" | "bad-csr";

export class BootstrapError extends Error {
  constructor(
    public readonly reason: BootstrapRejection,
    message: string,
  ) {
    super(message);
  }
}

// Find the provisioning server a raw bootstrap token belongs to: known, unexpired and unused, or a typed BootstrapError.
export function findServerForToken(
  servers: Server[],
  rawToken: string,
): Server {
  const hash = sha256Hex(rawToken);
  const server = servers.find((s) => s.bootstrap?.tokenHash === hash);
  if (!server || !server.bootstrap) {
    throw new BootstrapError(
      "unknown-token",
      "bootstrap token is not recognised",
    );
  }
  if (server.bootstrap.usedAt) {
    throw new BootstrapError(
      "already-used",
      "bootstrap token has already been used",
    );
  }
  if (new Date(server.bootstrap.expiresAt).getTime() < Date.now()) {
    throw new BootstrapError("expired-token", "bootstrap token has expired");
  }
  return server;
}

// Sign a calling-home agent's CSR for a server identified by its already-validated bootstrap token.
export async function signBootstrapCsr(
  csrPem: string,
  dialHosts: string[],
): Promise<SignedAgentCert> {
  try {
    return await signAgentCsr(csrPem, dialHosts);
  } catch (e) {
    throw new BootstrapError(
      "bad-csr",
      e instanceof Error ? e.message : "could not sign agent CSR",
    );
  }
}

// HMAC-sign a bootstrap response body with the raw token: a high-entropy key needs no KDF.
export function signResponse(rawToken: string, body: string): string {
  return createHmac("sha256", rawToken).update(body).digest("hex");
}

// Verify a response HMAC in constant time.
export function verifyResponse(
  rawToken: string,
  body: string,
  mac: string,
): boolean {
  const expected = signResponse(rawToken, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  return a.length === b.length && timingSafeEqual(a, b);
}
