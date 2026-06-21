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
 * control plane <-> server-agent RPC; see ADR-0006, PLAN P4). The control plane
 * IS the certificate authority: its CA private key is derived deterministically
 * from `DEPLO_SECRET` ({@link agentCaSeed}), so the same CA is reconstructed on
 * every restart with **no stored CA key** and no external CA. From that one root
 * we mint:
 *   - the agent's SERVER cert (the gRPC listener presents it),
 *   - the control plane's CLIENT cert (it presents this when it dials an agent).
 * Both are signed by the CA; each side pins the CA and requires the other to
 * present a CA-signed cert (mutual TLS). One trust model for the local agent
 * today and remote agents later.
 *
 * Ed25519 throughout: the CA key is a deterministic Ed25519 key built from the
 * 32-byte seed (Ed25519 needs only a seed, no point math), and Ed25519 X.509 is
 * validated identically by Node's TLS stack and Go's crypto/x509 — verified
 * cross-language. Leaf keys are random per issuance.
 */

const crypto = webcrypto;
x509.cryptoProvider.set(crypto as unknown as Crypto);

/** serverAuth / clientAuth EKU OIDs. */
const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

/**
 * Fixed PKCS#8 prefix for an Ed25519 private key: the DER header up to the
 * 32-byte raw seed (`SEQ{ INTEGER 0, SEQ{ OID 1.3.101.112 }, OCTET STRING{
 * OCTET STRING(32) } }`). Appending the seed yields a valid PKCS#8 key — the
 * one piece of ASN.1 we hand-assemble, so a CA key is a pure function of the
 * seed with no randomness.
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
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    alg,
    true,
    ["sign"],
  );
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

type SanEntry =
  | { type: "dns"; value: string }
  | { type: "ip"; value: string };

/**
 * The validity window for every minted leaf — server, client, or CSR-signed
 * agent cert: one year. Re-minted each install/dial cycle for the local agent;
 * for a remote agent the cert is stored in the Server row and the agent re-runs
 * the bootstrap to renew (or the control plane re-issues). Shared so the
 * "leaves live a year" rule is stated once.
 */
const LEAF_LIFETIME_MS = 365 * 24 * 3600_000;

/**
 * The shared certificate-issuance core. Builds a CA-signed leaf around a public
 * key — either one we generate here (local agent / control-plane client, where
 * we also return the private key) or one parsed from an agent's CSR (remote
 * bootstrap, where the private key never leaves the agent). `keyPem` in the
 * returned bundle is "" when the public key came from outside (we never had the
 * private half). Pure crypto, no I/O.
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
 * Mint the AGENT's server certificate. `hosts` are the names/IPs the control
 * plane may dial the agent by and become the cert's SANs (TLS verifies the
 * dialed host against them). For the local agent this is `localhost` +
 * `127.0.0.1`; for a remote agent it is the server's IP/host.
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
 * agent's signed SERVER cert, the pinned CA, and the cert's fingerprint (which
 * the control plane stores in the Server row to authenticate — and later revoke
 * — this exact agent).
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
 * because the agent was local. A REMOTE agent's private key must never leave the
 * remote, so the agent generates its own key pair, sends us a PKCS#10 CSR during
 * call-home, and we sign it here: the CA (derived from `DEPLO_SECRET`) issues a
 * server cert around the CSR's public key. We return the cert + CA + the cert's
 * fingerprint; the private key stays on the agent the whole time.
 *
 * `hosts` are the names/IPs the control plane will dial the agent by (its public
 * IP/host) and become the cert SANs — NOT taken from the CSR (a peer must not
 * choose its own SANs; the control plane decides who it will trust to answer for
 * which address). The CSR is verified (self-signature) before signing so a
 * malformed/forged request is rejected, but its only trusted contribution is the
 * public key.
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
 * The sha256(DER) fingerprint of a PEM certificate, lowercase hex. This is the
 * pinning identity used in BOTH directions of the agent trust model:
 *   - the control plane stores an agent cert's fingerprint in the Server row to
 *     authenticate that exact agent and revoke it on removal (P6);
 *   - the agent is handed the control plane's cert fingerprint in the bootstrap
 *     command and trusts the control plane iff the presented cert matches it
 *     (P3 — primary trust on IP-only deployments).
 * Computed from the DER bytes so it matches `openssl x509 -fingerprint -sha256`
 * and Go's crypto/sha256 over the same DER — verified cross-language.
 */
export async function certFingerprint(certPem: string): Promise<string> {
  const der = new x509.X509Certificate(certPem).rawData;
  const digest = await crypto.subtle.digest("SHA-256", der);
  return Buffer.from(digest).toString("hex");
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

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
