import "server-only";

import { connect as tlsConnect } from "node:tls";
import { createHmac, timingSafeEqual } from "node:crypto";
import { randomToken, sha256Hex } from "../crypto";
import { signAgentCsr, type SignedAgentCert } from "./pki";
import type { Server } from "../types";

/**
 * The call-home bootstrap (PLAN Part B, P1-P4). Provisioning a remote server is
 * NOT an outbound SSH-in (the control plane never holds a server's root key,
 * ADR-0003 anti-pattern). Instead `addServer()` mints a one-time token and an
 * install command; the operator runs it on the box with the privileges they
 * already have; the agent generates its OWN key + CSR and CALLS HOME to
 * `/api/agent/bootstrap`, presenting the token + CSR; the control plane (the CA,
 * key derived from DEPLO_SECRET) signs the CSR, pins the agent's cert
 * fingerprint, and flips the server `provisioning -> online`.
 *
 * This module owns the control-plane half of that handshake that is pure data /
 * crypto (token minting, the install command, token verification, the
 * HMAC-bound response). The HTTP wiring is the thin route at
 * `app/api/agent/bootstrap`; the agent half is in Go (`agent/internal/bootstrap`).
 *
 * TWO-WAY TRUST BEFORE THE TOKEN IS HONOURED (P2/P3):
 *   - the agent authenticates the control plane FIRST: over HTTPS it pins the
 *     control-plane cert fingerprint carried in the install command; in plain
 *     HTTP (the bare-IP, no-domain case) there is no cert to pin, so the token
 *     doubles as a shared secret — the control plane HMAC-signs the bootstrap
 *     response with the raw token, and the agent refuses a response whose HMAC
 *     it cannot reproduce. A MITM without the token cannot forge the CA it hands
 *     back, which is the value that matters (it anchors all future mTLS).
 *   - the control plane authenticates the agent via the single-use token + the
 *     CSR's proof-of-possession (its self-signature, verified in signAgentCsr).
 */

/** The agent's gRPC listener port the control plane will dial after bootstrap. */
export const DEFAULT_AGENT_PORT = 9443;

/** Bootstrap tokens are short-lived (P2): far shorter than a registration link. */
const BOOTSTRAP_TTL_MS = 60 * 60_000; // ~1 hour

/** A freshly minted bootstrap secret: the raw token (shown once) + what to store. */
export interface MintedBootstrap {
  /** The raw one-time token — embedded in the install command, never stored. */
  rawToken: string;
  /** sha256 of the token + its expiry — the only things persisted on the Server row. */
  stored: { tokenHash: string; expiresAt: string; usedAt: null };
}

/** Mint a one-time bootstrap secret for a provisioning server (P2). */
export function mintBootstrap(): MintedBootstrap {
  const rawToken = randomToken(32); // long + random
  return {
    rawToken,
    stored: {
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + BOOTSTRAP_TTL_MS).toISOString(),
      usedAt: null,
    },
  };
}

/**
 * Build the paste-on-the-server install command (P1). The script is served over
 * HTTPS from the control plane's own domain (reusing its existing cert);
 * `controlPlaneUrl` is the operator-configured public base URL. The fingerprint
 * (when the URL is HTTPS) lets the agent pin the control plane before sending
 * the token (P3). `baseUrl` MUST come from resolvePublicBaseUrl (never a raw
 * request header) — it is interpolated into a copy-and-run shell string.
 */
export function installCommand(opts: {
  baseUrl: string;
  rawToken: string;
  /** sha256 cert fingerprint of the control plane's TLS cert, or "" for HTTP. */
  fingerprint: string;
}): string {
  const { baseUrl, rawToken, fingerprint } = opts;
  // Order: <token> <control-plane-url> [fingerprint]. The script forwards them
  // to the agent's --bootstrap-* flags. Single-quoted so the shell treats them
  // as literals (the token is base64url, the url/fingerprint are constrained).
  const fp = fingerprint ? ` '${fingerprint}'` : "";
  return `curl -fsSL '${baseUrl}/install-agent.sh' | sudo bash -s -- '${rawToken}' '${baseUrl}'${fp}`;
}

/**
 * Build the paste-on-the-server UNINSTALL command — the counterpart to
 * {@link installCommand}, handed to the operator when they remove a server.
 *
 * Removing a server revokes the agent's trust, which is precisely when the
 * control plane loses the ability to command it; and no V1 RPC could delete the
 * binary, the systemd unit, Traefik or the `deplo` network in any case. So the
 * host cleanup is host-side, and this is the command that does it. No token: the
 * script only removes Deplo's own footprint from the box it runs on, and needs
 * root to do that anyway.
 *
 * `--yes` because the script is a dry run without it; `--purge-data` (which
 * deletes volumes and images) is deliberately NOT in the copy-and-run command —
 * the operator must reach for it consciously. `baseUrl` MUST come from
 * resolvePublicBaseUrl (never a raw request header) — it is interpolated into a
 * copy-and-run shell string.
 */
export function uninstallCommand(opts: { baseUrl: string }): string {
  return `curl -fsSL '${opts.baseUrl}/uninstall-agent.sh' | sudo bash -s -- --yes`;
}

/**
 * Read the sha256 fingerprint of the cert the control plane's own public URL
 * serves, by making a TLS connection to it. Used to embed the pin in the install
 * command (P3). Returns "" for a non-HTTPS URL (the bare-IP case — the agent
 * falls back to the HMAC-bound path) or if the cert can't be read. Best-effort:
 * a failure here just degrades to the HTTP trust path, never blocks minting.
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

/** Why a bootstrap attempt was rejected — surfaced to the agent + the log. */
export type BootstrapRejection =
  | "unknown-token"
  | "expired-token"
  | "already-used"
  | "bad-csr";

export class BootstrapError extends Error {
  constructor(public readonly reason: BootstrapRejection, message: string) {
    super(message);
  }
}

/**
 * Find the provisioning server a raw bootstrap token belongs to. Pure lookup
 * over a server list (so it is trivially testable and the caller owns the store
 * read). Validates the token is known, unexpired, and unused — throwing a
 * typed {@link BootstrapError} otherwise. Constant-time matching is unnecessary
 * here: the token is matched by its sha256 (an exact map-style lookup over a
 * hash), so there is no byte-by-byte secret comparison to leak timing on.
 */
export function findServerForToken(
  servers: Server[],
  rawToken: string,
): Server {
  const hash = sha256Hex(rawToken);
  const server = servers.find((s) => s.bootstrap?.tokenHash === hash);
  if (!server || !server.bootstrap) {
    throw new BootstrapError("unknown-token", "bootstrap token is not recognised");
  }
  if (server.bootstrap.usedAt) {
    throw new BootstrapError("already-used", "bootstrap token has already been used");
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
 * validated) bootstrap token. `dialHosts` are the addresses the control plane
 * will dial the agent by — its public IP/host — and become the cert SANs (the
 * agent does not get to choose them; signAgentCsr enforces this). Pure crypto +
 * the CSR sign; the caller is responsible for the store mutation that pins the
 * result and flips the server to online.
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
 * The agent, which holds the token, recomputes this and refuses a mismatch — so
 * a network attacker who never had the token cannot substitute their own CA in
 * the response. Over HTTPS this is belt-and-suspenders on top of the agent's
 * fingerprint pin; over plain HTTP it is the only thing binding the response to
 * a party that knew the token. Keyed by the RAW token (a high-entropy secret),
 * so a plain HMAC-SHA256 is sufficient — no KDF needed.
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
