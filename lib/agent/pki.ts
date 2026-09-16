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

const crypto = webcrypto;
x509.cryptoProvider.set(crypto as unknown as Crypto);

const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

function ed25519KeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

async function toWebCryptoKeys(node: KeyObject): Promise<CryptoKeyPair> {
  // A Node Buffer is generic over ArrayBufferLike; WebCrypto wants a real ArrayBuffer.
  const pkcs8 = new Uint8Array(
    node.export({ format: "der", type: "pkcs8" }) as Buffer,
  );
  const spki = new Uint8Array(
    createPublicKey(node).export({ format: "der", type: "spki" }) as Buffer,
  );
  const alg = { name: "Ed25519" };
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, alg, true, [
    "sign",
  ]);
  const publicKey = await crypto.subtle.importKey("spki", spki, alg, true, [
    "verify",
  ]);
  // x509 types against the DOM CryptoKey; node's webcrypto is structurally its own.
  return { privateKey, publicKey } as unknown as CryptoKeyPair;
}

function pemPrivateKey(node: KeyObject): string {
  return node.export({ format: "pem", type: "pkcs8" }).toString();
}

let caCache: { caPem: string; caKeys: CryptoKeyPair; subject: string } | null =
  null;

async function getCa(): Promise<{
  caPem: string;
  caKeys: CryptoKeyPair;
  subject: string;
}> {
  if (caCache) return caCache;
  const caKeys = await toWebCryptoKeys(ed25519KeyFromSeed(agentCaSeed()));
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

export async function caCertPem(): Promise<string> {
  return (await getCa()).caPem;
}

export interface CertBundle {
  certPem: string;
  keyPem: string;
  caPem: string;
}

type SanEntry = { type: "dns"; value: string } | { type: "ip"; value: string };

const LEAF_LIFETIME_MS = 365 * 24 * 3600_000;

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

export async function issueAgentServerCert(
  hosts: string[],
): Promise<CertBundle> {
  const sans = hostsToSans(hosts);
  return issueLeaf("deplo-agent", sans, EKU_SERVER_AUTH);
}

export async function issueControlPlaneClientCert(): Promise<CertBundle> {
  return issueLeaf(
    "deplo-control-plane",
    [{ type: "dns", value: "deplo-control-plane" }],
    EKU_CLIENT_AUTH,
  );
}

export interface SignedAgentCert {
  certPem: string;
  caPem: string;
  fingerprint: string;
}

export async function signAgentCsr(
  csrPem: string,
  hosts: string[],
): Promise<SignedAgentCert> {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  // The CSR self-signature is proof of possession: a forged or replayed CSR is never signed.
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

export async function certFingerprint(certPem: string): Promise<string> {
  const der = new x509.X509Certificate(certPem).rawData;
  const digest = await crypto.subtle.digest("SHA-256", der);
  return Buffer.from(digest).toString("hex");
}

export const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function hostsToSans(hosts: string[]): SanEntry[] {
  const entries = hosts
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h): SanEntry =>
      IPV4_RE.test(h) ? { type: "ip", value: h } : { type: "dns", value: h },
    );
  if (!entries.some((e) => e.type === "dns" && e.value === "localhost"))
    entries.push({ type: "dns", value: "localhost" });
  if (!entries.some((e) => e.type === "ip" && e.value === "127.0.0.1"))
    entries.push({ type: "ip", value: "127.0.0.1" });
  return entries;
}
