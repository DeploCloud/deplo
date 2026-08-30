// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// https://deplo.build/docs/guides/server/add-a-server

import { connect as tlsConnect } from "node:tls";
import { createHmac, timingSafeEqual } from "node:crypto";
import { randomToken, sha256Hex } from "../crypto";
import { signAgentCsr, type SignedAgentCert } from "./pki";
import type { Server } from "../types";
import { PUBLIC_URL_PLACEHOLDER } from "../public-url";
import { isTestEnv } from "../db/pg";

/**
 * The call-home bootstrap (PLAN Part B, P1-P4). Provisioning a remote server is
 * NOT an outbound SSH-in (the control plane never holds a server's root key,
 * ADR-0003 anti-pattern).
 */

/** The agent's gRPC listener port the control plane will dial after bootstrap. */
export const DEFAULT_AGENT_PORT = 9443;

/** Bootstrap tokens are short-lived (P2): far shorter than a registration link. */
const BOOTSTRAP_TTL_MS = 60 * 60_000; // ~1 hour

/** A freshly minted bootstrap secret: the raw token (shown once) + what to store. */
export interface MintedBootstrap {
  /** The raw one-time token - embedded in the install command, never stored. */
  rawToken: string;
  /** sha256 of the token + its expiry - the only things persisted on the Server row. */
  stored: { tokenHash: string; expiresAt: string; usedAt: null };
}

/** Mint a one-time bootstrap secret for a provisioning server (P2). */
export function mintBootstrap(): MintedBootstrap {
  const rawToken = randomToken(32); // long + random
  return { rawToken, stored: storedBootstrapFor(rawToken) };
}

/**
 * The stored half of a bootstrap for a token the caller ALREADY holds, rather than
 * one minted here.
 */
export function storedBootstrapFor(
  rawToken: string,
): MintedBootstrap["stored"] {
  return {
    tokenHash: sha256Hex(rawToken),
    expiresAt: new Date(Date.now() + BOOTSTRAP_TTL_MS).toISOString(),
    usedAt: null,
  };
}

/**
 * Build the paste-on-the-server install command (P1). The fingerprint (when the
 * URL is HTTPS) lets the agent pin the control plane before sending the token
 * (P3).
 */
export function installCommand(opts: {
  baseUrl: string;
  rawToken: string;
  /** sha256 cert fingerprint of the control plane's TLS cert, or "" for HTTP. */
  fingerprint: string;
  /**
   * A server that only HOLDS BACKUPS: no Docker, no Traefik, no address pools, and
   * a systemd unit with no `docker` group (which would otherwise refuse to start
   * on a host that has none).
   */
  storageOnly?: boolean;
  /**
   * A server that only BUILDS: Docker and the address pools exactly as usual (it
   * runs the whole build pipeline), but no Traefik - nothing is routed to a host
   * that runs nothing.
   */
  buildOnly?: boolean;
  /**
   * A server registered only to IMPORT from another platform: Docker is already
   * there (it is that platform's host) and is never installed, no address pools
   * are written, no Traefik, and not even the shared `deplo` network.
   */
  importOnly?: boolean;
}): string {
  const { baseUrl, rawToken, fingerprint, storageOnly, buildOnly, importOnly } =
    opts;
  // Order: <token> <control-plane-url> [fingerprint]. The script forwards them
  // to the agent's --bootstrap-* flags. Single-quoted so the shell treats them
  // as literals (the token is base64url, the url/fingerprint are constrained).
  const fp = fingerprint ? ` '${fingerprint}'` : "";
  // `sudo` does not forward the caller's environment, so the variable is set
  // INSIDE the elevated shell - `DEPLO_STORAGE_ONLY=1 sudo bash` would silently
  // install a normal agent.
  const env = importOnly
    ? "DEPLO_IMPORT_ONLY=1 "
    : storageOnly
      ? "DEPLO_STORAGE_ONLY=1 "
      : buildOnly
        ? "DEPLO_BUILD_ONLY=1 "
        : "";
  return `curl -fsSL '${baseUrl}/install-agent.sh' | sudo ${env}bash -s -- '${rawToken}' '${baseUrl}'${fp}`;
}

/**
 * Build the paste-on-the-server UNINSTALL command - the counterpart to {@link
 * installCommand}, handed to the operator when they remove a server.
 */
export function uninstallCommand(opts: { baseUrl: string }): string {
  return `curl -fsSL '${opts.baseUrl}/uninstall.sh' | sudo bash -s -- --yes --agent-only`;
}

/**
 * Read the sha256 fingerprint of the cert the control plane's own public URL
 * serves. Empty over plain HTTP, where the agent uses the HMAC path instead.
 *
 * Over HTTPS it THROWS rather than answering empty: the agent refuses to start
 * without a pinned fingerprint ("HTTPS control plane requires a pinned
 * fingerprint"), so a command minted without one is a command that cannot work,
 * handed over with a green "the agent is calling home".
 */
export async function controlPlaneCertFingerprint(
  baseUrl: string,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  // Nothing to dial: the instance does not know its own address yet, which is a
  // different problem from a cert that cannot be read, and has its own answer.
  if (baseUrl.replace(/\/+$/, "") === PUBLIC_URL_PLACEHOLDER) return "";
  // Once more before giving up: this dials Deplo's own public address, which can
  // sit behind a proxy that drops one connection in a while.
  const fingerprint =
    (await readCertFingerprint(url)) || (await readCertFingerprint(url));
  // Nothing is dialable from a test worker, and every server a test registers
  // would otherwise fail on an address that does not exist.
  if (!isTestEnv()) assertPinnableFingerprint(url, fingerprint);
  return fingerprint;
}

/**
 * Refuse to mint a command that cannot work. The agent will not bootstrap against
 * an HTTPS control plane without a pinned fingerprint, so an empty one produces a
 * service in a restart loop behind a command that exited 0 and said it was
 * calling home.
 */
export function assertPinnableFingerprint(url: URL, fingerprint: string): void {
  if (url.protocol !== "https:" || fingerprint) return;
  throw new Error(
    `Deplo could not read the certificate its own address (${url.origin}) serves, so the install command would produce an agent that refuses to start. Check that ${url.hostname} answers on port ${url.port || 443} from this machine, then try again.`,
  );
}

function readCertFingerprint(url: URL): Promise<string> {
  const port = url.port ? Number(url.port) : 443;
  return new Promise<string>((resolve) => {
    const sock = tlsConnect(
      {
        host: url.hostname,
        port,
        servername: url.hostname,
        // We only want to READ the presented cert's fingerprint; we are not
        // authenticating here (the agent does the pinning). Don't fail on an
        // unknown CA (self-signed-on-IP is explicitly supported, P3).
        rejectUnauthorized: false,
        timeout: 5_000,
      },
      () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        if (cert && cert.fingerprint256) {
          resolve(cert.fingerprint256.replace(/:/g, "").toLowerCase());
        } else {
          resolve("");
        }
      },
    );
    sock.on("error", () => resolve(""));
    sock.on("timeout", () => {
      sock.destroy();
      resolve("");
    });
  });
}

/** Why a bootstrap attempt was rejected - surfaced to the agent + the log. */
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

/**
 * Find the provisioning server a raw bootstrap token belongs to. Validates the
 * token is known, unexpired, and unused - throwing a typed {@link BootstrapError}
 * otherwise.
 */
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

/** The signed-cert payload the control plane returns to a calling-home agent. */
export interface BootstrapResult {
  /** The agent's signed server cert + pinned CA + the cert fingerprint. */
  signed: SignedAgentCert;
  /** The agent's gRPC port the control plane will dial it on. */
  agentPort: number;
}

/**
 * Sign a calling-home agent's CSR for a server identified by its (already
 * validated) bootstrap token.
 */
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

/**
 * HMAC-sign a bootstrap response body with the raw token (the HTTP trust path).
 * Keyed by the RAW token (a high-entropy secret), so a plain HMAC-SHA256 is
 * sufficient, no KDF needed.
 */
export function signResponse(rawToken: string, body: string): string {
  return createHmac("sha256", rawToken).update(body).digest("hex");
}

/** Verify a response HMAC in constant time (used by tests + symmetry). */
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
