import "server-only";

import * as x509 from "@peculiar/x509";
import {
  webcrypto,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { agentCaSeed } from "../crypto";

/**
 * The agent mTLS PKI — the trust layer behind the second system boundary (the
 * control plane <-> server-agent RPC; see ADR-0006, PLAN P4).
 */

const crypto = webcrypto;
x509.cryptoProvider.set(crypto as unknown as Crypto);

/** serverAuth / clientAuth EKU OIDs. */
const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

/**
 * Fixed PKCS#8 prefix for an Ed25519 private key: the DER header up to the 32-byte
 * raw seed (`SEQ{ INTEGER 0, SEQ{ OID 1.3.101.112 }, OCTET STRING{ OCTET
 * STRING(32) } }`).
 */
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/** A Node Ed25519 private key built deterministically from a 32-byte seed. */
function ed25519KeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** Import a Node Ed25519 private key into a WebCrypto keypair for @peculiar. */
async function toWebCryptoKeys(node: KeyObject): Promise<CryptoKeyPair> {
  const pkcs8 = node.export({ format: "der", type: "pkcs8" }) as Buffer;
  const spki = createPublicKey(node).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  const alg = { name: "Ed25519" };
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, alg, true, [
    "sign",
  ]);
  const publicKey = await crypto.subtle.importKey("spki", spki, alg, true, [
    "verify",
  ]);
  return { privateKey, publicKey };
}

function pemPrivateKey(node: KeyObject): string {
  return node.export({ format: "pem", type: "pkcs8" }).toString();
}

/** Cached, deterministic CA materials (cert + signing key) for this process. */
let caCache: { caPem: string; caKeys: CryptoKeyPair; subject: string } | null =
  null;

/**
 * The deterministic CA, rebuilt from {@link agentCaSeed}. Cached for the process
 * lifetime. Re-derived (not stored), so a restart yields a byte-identical CA as
 * long as `DEPLO_SECRET` is unchanged.
 */
async function getCa(): Promise<{
  caPem: string;
  caKeys: CryptoKeyPair;
  subject: string;
}> {
  if (caCache) return caCache;
  const caKeys = await toWebCryptoKeys(ed25519KeyFromSeed(agentCaSeed()));
  // A FIXED notBefore/serial keeps the CA cert bytes stable across restarts.
  // The validity window is wide (10y) — the CA's lifetime is the instance's.
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Deplo Agent CA",
    notBefore: new Date("2020-01-01T00:00:00Z"),
    notAfter: new Date("2040-01-01T00:00:00Z"),
    keys: caKeys,
    signingAlgorithm: { name: "Ed25519" },
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  caCache = {
    caPem: caCert.toString("pem"),
    caKeys,
    subject: caCert.subject,
  };
  return caCache;
}

/** The CA certificate (PEM) the control plane and agents pin. */
export async function caCertPem(): Promise<string> {
  return (await getCa()).caPem;
}

/** A minted leaf: the certificate chain (leaf PEM) + its private key (PEM). */
export interface CertBundle {
  /** The leaf certificate, PEM. */
  certPem: string;
  /** The leaf private key, PEM (PKCS#8). */
  keyPem: string;
  /** The pinned CA certificate, PEM — both sides verify against it. */
  caPem: string;
}

type SanEntry = { type: "dns"; value: string } | { type: "ip"; value: string };

/**
 * The validity window for every minted leaf — server, client, or CSR-signed agent
 * cert: one year.
 */
const LEAF_LIFETIME_MS = 365 * 24 * 3600_000;

/**
 * The shared certificate-issuance core. `keyPem` in the returned bundle is "" when
 * the public key came from outside (we never had the private half).
 */
async function issueCertFor(
  publicKey: CryptoKey,
  commonName: string,
  sans: SanEntry[],
  eku: string,
): Promise<x509.X509Certificate> {
  const { caKeys, subject } = await getCa();
  const san = new x509.GeneralNames(sans);
  return x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(8).toString("hex"),
    subject: `CN=${commonName}`,
    issuer: subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + LEAF_LIFETIME_MS),
    signingKey: caKeys.privateKey,
    publicKey,
    signingAlgorithm: { name: "Ed25519" },
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.ExtendedKeyUsageExtension([eku], true),
      new x509.SubjectAlternativeNameExtension(san.toJSON()),
    ],
  });
}

/** Mint a leaf cert (server or client) with a freshly-generated key pair. */
async function issueLeaf(
  commonName: string,
  sans: SanEntry[],
  eku: string,
): Promise<CertBundle> {
  const { caPem } = await getCa();
  const leafNode = ed25519KeyFromSeed(randomBytes(32));
  const leafKeys = await toWebCryptoKeys(leafNode);
  const cert = await issueCertFor(leafKeys.publicKey, commonName, sans, eku);
  return {
    certPem: cert.toString("pem"),
    keyPem: pemPrivateKey(leafNode),
    caPem,
  };
}

/**
 * Mint the AGENT's server certificate.
 */
export async function issueAgentServerCert(
  hosts: string[],
): Promise<CertBundle> {
  const sans = hostsToSans(hosts);
  return issueLeaf("deplo-agent", sans, EKU_SERVER_AUTH);
}

/**
 * Mint the CONTROL PLANE's client certificate, presented when it dials an
 * agent. The agent requires a CA-signed client cert, so a peer without one
 * (anything but this control plane) cannot complete the handshake.
 */
export async function issueControlPlaneClientCert(): Promise<CertBundle> {
  return issueLeaf(
    "deplo-control-plane",
    [{ type: "dns", value: "deplo-control-plane" }],
    EKU_CLIENT_AUTH,
  );
}

/**
 * The result of signing a remote agent's CSR during call-home bootstrap: the
 * agent's signed SERVER cert, the pinned CA, and the cert's fingerprint (which the
 * control plane stores in the Server row to authenticate — and later revoke — this
 * exact agent).
 */
export interface SignedAgentCert {
  /** The agent's signed leaf certificate, PEM. */
  certPem: string;
  /** The pinned CA certificate, PEM (the agent verifies the control plane with it). */
  caPem: string;
  /** sha256(DER) of the issued cert, lowercase hex — the pinning identity (P6). */
  fingerprint: string;
}

/**
 * THE TRUST-DIRECTION INVERSION (PLAN P1-P4). In Part A the control plane minted
 * the agent's cert AND its key and wrote both to the agent's disk — possible only
 * because the agent was local.
 */
export async function signAgentCsr(
  csrPem: string,
  hosts: string[],
): Promise<SignedAgentCert> {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  // Verify the CSR's self-signature: proves the requester holds the private key
  // for the public key it presents (proof-of-possession). A forged/garbled CSR
  // fails here and is never signed.
  if (!(await csr.verify())) {
    throw new Error("agent CSR self-signature is invalid");
  }
  const publicKey = await csr.publicKey.export(crypto as unknown as Crypto);
  const cert = await issueCertFor(
    publicKey,
    "deplo-agent",
    hostsToSans(hosts),
    EKU_SERVER_AUTH,
  );
  return {
    certPem: cert.toString("pem"),
    caPem: await caCertPem(),
    fingerprint: await certFingerprint(cert.toString("pem")),
  };
}

/**
 * The sha256(DER) fingerprint of a PEM certificate, lowercase hex.
 */
export async function certFingerprint(certPem: string): Promise<string> {
  const der = new x509.X509Certificate(certPem).rawData;
  const digest = await crypto.subtle.digest("SHA-256", der);
  return Buffer.from(digest).toString("hex");
}

/**
 * IPv4 literal matcher. Exported so the dial path (agent-client) classifies a host
 * the SAME way SAN generation does here — an IP literal gets an `ip` SAN and,
 * because TLS SNI forbids IP servernames, is verified via a DNS SAN at dial time.
 */
export const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Map dial targets to SAN entries (IPv4 literals -> ip SANs, else dns). */
function hostsToSans(hosts: string[]): SanEntry[] {
  const entries = hosts
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h): SanEntry =>
      IPV4_RE.test(h) ? { type: "ip", value: h } : { type: "dns", value: h },
    );
  // Always include localhost/127.0.0.1 so a same-host dial verifies.
  if (!entries.some((e) => e.type === "dns" && e.value === "localhost"))
    entries.push({ type: "dns", value: "localhost" });
  if (!entries.some((e) => e.type === "ip" && e.value === "127.0.0.1"))
    entries.push({ type: "ip", value: "127.0.0.1" });
  return entries;
}
