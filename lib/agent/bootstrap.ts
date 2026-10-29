import "server-only";

import { connect as tlsConnect } from "node:tls";
import {
  createHash,
  createHmac,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import { randomToken, sha256Hex } from "../crypto";
import { signAgentCsr, type SignedAgentCert } from "./pki";
import type { Server } from "../types/server";
import { PUBLIC_URL_PLACEHOLDER } from "../public-url";
import { isTestEnv } from "../db/pg";

const BOOTSTRAP_TTL_MS = 60 * 60_000;

export interface MintedBootstrap {
  rawToken: string;
  stored: { tokenHash: string; expiresAt: string; usedAt: null };
}

export function mintBootstrap(): MintedBootstrap {
  const rawToken = randomToken(32);
  return { rawToken, stored: storedBootstrapFor(rawToken) };
}

export function storedBootstrapFor(
  rawToken: string,
): MintedBootstrap["stored"] {
  return {
    tokenHash: sha256Hex(rawToken),
    expiresAt: new Date(Date.now() + BOOTSTRAP_TTL_MS).toISOString(),
    usedAt: null,
  };
}

export function installCommand(opts: {
  baseUrl: string;
  rawToken: string;
  fingerprint: string;
  insecure?: boolean;
  pin?: string;
  storageOnly?: boolean;
  buildOnly?: boolean;
  importOnly?: boolean;
}): string {
  const {
    baseUrl,
    rawToken,
    fingerprint,
    insecure,
    pin,
    storageOnly,
    buildOnly,
    importOnly,
  } = opts;
  const fp = fingerprint ? ` '${fingerprint}'` : "";
  // Set after sudo, which drops the caller's environment - before it, the flag is silently ignored.
  const env = importOnly
    ? "DEPLO_IMPORT_ONLY=1 "
    : storageOnly
      ? "DEPLO_STORAGE_ONLY=1 "
      : buildOnly
        ? "DEPLO_BUILD_ONLY=1 "
        : "";
  // Download then run, never curl | bash (a failed fetch exits 0 silently); --output, not -o, which ad blockers strip.
  // The token goes in on stdin (`-`): sudo's argv is readable by every local user for the whole install.
  return `curl ${curlFlags(insecure, pin)} '${baseUrl}/install-agent.sh' --output /tmp/deplo-agent-install.sh && echo '${rawToken}' | sudo ${env}bash /tmp/deplo-agent-install.sh - '${baseUrl}'${fp}`;
}

export function uninstallCommand(opts: {
  baseUrl: string;
  insecure?: boolean;
  pin?: string;
}): string {
  return `curl ${curlFlags(opts.insecure, opts.pin)} '${opts.baseUrl}/uninstall.sh' --output /tmp/deplo-uninstall.sh && sudo bash /tmp/deplo-uninstall.sh --yes --agent-only`;
}

// -k skips only the CA check: curl still refuses any key but the one Deplo read off its own address.
function curlFlags(insecure?: boolean, pin?: string): string {
  if (!insecure) return "-fsSL";
  return pin ? `-fsSLk --pinnedpubkey 'sha256//${pin}'` : "-fsSLk";
}

export async function controlPlaneCert(
  baseUrl: string,
): Promise<ControlPlaneCert> {
  const none = { fingerprint: "", insecure: false, pin: "" };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return none;
  }
  if (url.protocol !== "https:") return none;
  if (baseUrl.replace(/\/+$/, "") === PUBLIC_URL_PLACEHOLDER) return none;
  const first = await readCert(url);
  const cert = first.fingerprint ? first : await readCert(url);
  if (!isTestEnv()) assertPinnableFingerprint(url, cert.fingerprint);
  return cert;
}

export function assertPinnableFingerprint(url: URL, fingerprint: string): void {
  if (url.protocol !== "https:" || fingerprint) return;
  throw new Error(
    `Deplo could not read the certificate its own address (${url.origin}) serves, so the install command would produce an agent that refuses to start. Check that ${url.hostname} answers on port ${url.port || 443} from this machine, then try again.`,
  );
}

export type ControlPlaneCert = {
  fingerprint: string;
  insecure: boolean;
  // curl's --pinnedpubkey form: base64 sha256 of the certificate's public key.
  pin: string;
};

export function publicKeyPin(rawCert: Buffer): string {
  try {
    const spki = new X509Certificate(rawCert).publicKey.export({
      type: "spki",
      format: "der",
    });
    return createHash("sha256").update(spki).digest("base64");
  } catch {
    return "";
  }
}

function readCert(url: URL): Promise<ControlPlaneCert> {
  const port = url.port ? Number(url.port) : 443;
  return new Promise<ControlPlaneCert>((resolve) => {
    const sock = tlsConnect(
      {
        host: url.hostname,
        port,
        servername: url.hostname,
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
        const pin = cert?.raw ? publicKeyPin(cert.raw) : "";
        resolve({ fingerprint, insecure: !!fingerprint && !authorized, pin });
      },
    );
    const nothing = { fingerprint: "", insecure: false, pin: "" };
    sock.on("error", () => resolve(nothing));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(nothing);
    });
  });
}

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

export function signResponse(rawToken: string, body: string): string {
  return createHmac("sha256", rawToken).update(body).digest("hex");
}

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
