import "server-only";

import { X509Certificate, createPrivateKey } from "node:crypto";

import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import { getCurrentUser } from "../auth";
import {
  traefikCertificates,
  withTraefikCertificates,
  type CustomCertificate,
} from "../deploy/traefik-stack";
import { recordActivity } from "./activity";
import { getServerById } from "./servers";

/**
 * Custom TLS certificates on ONE server: the "I already bought a certificate"
 * escape hatch next to the Let's Encrypt one Deplo issues by itself.
 *
 * They live in the host's own Traefik stack file and nowhere else. No table, no
 * column, no copy in the control plane: the host is the only place the proxy can
 * read a certificate from, so it is also the only honest answer to "what is
 * installed here", the same reason the ACME account email and the dashboard
 * domain are read live rather than stored.
 *
 * Traefik picks a certificate by SNI, so an installed certificate covers every
 * domain named in it that is served over HTTPS on this host, and it takes
 * precedence over Let's Encrypt: Traefik does not request a certificate for a
 * domain the store already covers.
 *
 * Instance-admin gated, like every other host action: a certificate here fronts
 * whatever any team runs on this server.
 */

/** An installed certificate, described from the certificate itself. The private
 *  key is never part of this: it goes to the host and has no read path. */
export type ServerCertificate = {
  /** SHA-256 fingerprint. The certificate's own identity, so nothing has to be
   *  minted or stored to address one. */
  id: string;
  /** Common name, or the first domain when the certificate carries no CN. */
  subject: string;
  /** Every hostname it is valid for (its SANs, falling back to the CN). */
  domains: string[];
  issuer: string;
  notBefore: string;
  notAfter: string;
  /** Whether it is past its expiry right now. A certificate can expire in place
   *  long after it was accepted. */
  expired: boolean;
  /** Whole days until it expires, negative once it has. Computed here rather
   *  than in the browser: the countdown must not depend on the viewer's clock. */
  expiresInDays: number;
};

export type CertificateInput = { certPem: string; keyPem: string };

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** What this host is serving, read from its live stack file. */
export async function listServerCertificates(
  serverId: string,
): Promise<ServerCertificate[]> {
  await requireInstanceAdmin();
  const { yaml } = await readStack(serverId);
  return describeAll(traefikCertificates(yaml));
}

/** Describe a host's certificates, skipping any Deplo cannot read: one entry
 *  mangled by hand must not make the whole tab an error page. */
function describeAll(certificates: CustomCertificate[]): ServerCertificate[] {
  return certificates.flatMap((c) => {
    try {
      return [describe(c)];
    } catch {
      return [];
    }
  });
}

/** This certificate's identity, or null when it cannot be read. */
function identify(certificate: CustomCertificate): ServerCertificate | null {
  try {
    return describe(certificate);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Install a certificate on a server.
 *
 * A certificate covering the SAME domains replaces the one already there: that
 * is what renewing one looks like, and leaving both would let Traefik answer
 * with either. Applying recreates the proxy, so routing on this host blips.
 */
export async function addServerCertificate(
  serverId: string,
  input: CertificateInput,
): Promise<ServerCertificate[]> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  // Validated BEFORE the host is dialed: a malformed PEM must come back as "this
  // is not a certificate", never as "server unreachable".
  const added = parseCertificate(input);
  const description = describe(added);

  const { server, yaml } = await readStack(serverId);
  const current = traefikCertificates(yaml);
  const next = [
    ...current.filter(
      (c) => identify(c)?.domains.join() !== description.domains.join(),
    ),
    added,
  ];

  await applyCertificates(serverId, server.name, yaml, next);
  await recordActivity(
    "member",
    `Installed a TLS certificate for ${description.domains.join(", ")} on ${server.name}`,
    user.name,
    null,
    teamId,
  );
  return describeAll(next);
}

/** Remove one certificate by fingerprint. The proxy falls back to whatever else
 *  covers those domains, usually Let's Encrypt, which will re-issue. */
export async function removeServerCertificate(
  serverId: string,
  certificateId: string,
): Promise<ServerCertificate[]> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const { server, yaml } = await readStack(serverId);
  const current = traefikCertificates(yaml);
  const target = current.find((c) => identify(c)?.id === certificateId);
  if (!target)
    throw new Error(`That certificate is not installed on ${server.name}`);
  const next = current.filter((c) => c !== target);

  await applyCertificates(serverId, server.name, yaml, next);
  await recordActivity(
    "member",
    `Removed the TLS certificate for ${identify(target)?.domains.join(", ")} from ${server.name}`,
    user.name,
    null,
    teamId,
  );
  return describeAll(next);
}

/* ------------------------------------------------------------------ */
/* The host                                                            */
/* ------------------------------------------------------------------ */

/** The server row plus its live Traefik stack file, refusing early on a host
 *  whose proxy Deplo did not install: there is nothing to write there. */
async function readStack(serverId: string) {
  const server = await getServerById(serverId);
  if (!server) throw new Error("Server not found");
  const { fetchHostInfo } = await import("../infra/agent-client");
  const info = await fetchHostInfo(serverId);
  if (!info.traefikComposeYaml)
    throw new Error(
      `Deplo did not install the proxy on ${server.name}, so it cannot manage certificates there. Install them in your own proxy instead.`,
    );
  return { server, yaml: info.traefikComposeYaml };
}

async function applyCertificates(
  serverId: string,
  serverName: string,
  currentYaml: string,
  certificates: CustomCertificate[],
): Promise<void> {
  const { applyTraefikConfig } = await import("../infra/agent-client");
  const composeYaml = withTraefikCertificates(currentYaml, certificates);
  const res = await applyTraefikConfig(serverId, { composeYaml });
  if (!res.ok)
    throw new Error(res.error || `Could not apply the certificate on ${serverName}`);
}

/* ------------------------------------------------------------------ */
/* The certificate itself                                              */
/* ------------------------------------------------------------------ */

/**
 * Read and check a pasted certificate + key.
 *
 * Everything a host cannot tell us afterwards is checked here: that the PEM is a
 * certificate at all, that the key is the one it was issued for (a mismatched
 * pair makes Traefik serve its self-signed default and nothing says why), and
 * that it has not already expired. The chain is kept VERBATIM: a full chain is
 * several certificates in one PEM and the intermediates are what browsers need.
 */
function parseCertificate(input: CertificateInput): CustomCertificate {
  const certPem = input.certPem.trim();
  const keyPem = input.keyPem.trim();
  if (!certPem.includes("BEGIN CERTIFICATE"))
    throw new Error(
      "That is not a certificate. Paste the PEM text, starting with -----BEGIN CERTIFICATE-----",
    );

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch (e) {
    throw new Error(
      `Deplo could not read that certificate: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new Error(
      "Deplo could not read that private key. Paste the PEM text, starting with -----BEGIN PRIVATE KEY-----, and remove its passphrase if it has one.",
    );
  }
  if (!cert.checkPrivateKey(key))
    throw new Error("That private key does not belong to that certificate");
  const notAfter = new Date(cert.validTo);
  if (notAfter.getTime() < Date.now())
    throw new Error(
      `That certificate expired on ${notAfter.toISOString().slice(0, 10)}. Renew it and upload the new one.`,
    );

  // Trailing newline: PEM files carry one, and some readers are fussy about it.
  return { certPem: `${certPem}\n`, keyPem: `${keyPem}\n` };
}

/** Describe an installed certificate. Never touches the key. */
function describe(certificate: CustomCertificate): ServerCertificate {
  const cert = new X509Certificate(certificate.certPem);
  const cn = subjectCommonName(cert.subject);
  const domains = subjectAltNames(cert.subjectAltName);
  // `validFrom`/`validTo` rather than the Date pair: the strings are what every
  // Node version carries, and they parse to the same instant.
  const notBefore = new Date(cert.validFrom);
  const notAfter = new Date(cert.validTo);
  const msLeft = notAfter.getTime() - Date.now();
  return {
    id: cert.fingerprint256,
    subject: cn || domains[0] || "Unnamed certificate",
    domains: domains.length > 0 ? domains : cn ? [cn] : [],
    issuer: subjectCommonName(cert.issuer) || cert.issuer.split("\n")[0] || "Unknown issuer",
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    expired: msLeft < 0,
    expiresInDays: Math.floor(msLeft / 86_400_000),
  };
}

/** Node renders a subject as newline-separated `KEY=value` pairs. */
function subjectCommonName(subject: string): string {
  for (const line of subject.split("\n")) {
    if (line.startsWith("CN=")) return line.slice(3).trim();
  }
  return "";
}

/** `subjectAltName` is `DNS:a.example.com, DNS:*.example.com, IP Address:x`:
 *  only the DNS entries are hostnames a browser will match. */
function subjectAltNames(altName: string | undefined): string[] {
  if (!altName) return [];
  return altName
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("DNS:"))
    .map((part) => part.slice(4).trim())
    .filter(Boolean);
}
