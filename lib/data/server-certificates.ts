import "server-only";

// https://deplo.build/docs/advanced/custom-certificates

import { X509Certificate, createPrivateKey } from "node:crypto";

import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import { getCurrentUser } from "../auth/current-user";
import {
  traefikCertificates,
  withTraefikCertificates,
  type CustomCertificate,
} from "../deploy/traefik-stack";
import { recordActivity } from "./activity";
import { getServerById } from "./servers/roster";

/** An installed certificate, described from the certificate itself; never its private key. */
export type ServerCertificate = {
  /** SHA-256 fingerprint: the certificate's own identity, nothing minted or stored. */
  id: string;
  /** Common name, or the first domain when the certificate carries no CN. */
  subject: string;
  /** Every hostname it is valid for (its SANs, falling back to the CN). */
  domains: string[];
  issuer: string;
  notBefore: string;
  notAfter: string;
  /** Whether it is past its expiry right now: a certificate can expire in place. */
  expired: boolean;
  /** Whole days until it expires, negative once it has. Never the viewer's clock. */
  expiresInDays: number;
};

export type CertificateInput = { certPem: string; keyPem: string };

/** What this host is serving, read from its live stack file. */
export async function listServerCertificates(
  serverId: string,
): Promise<ServerCertificate[]> {
  await requireInstanceAdmin();
  const { yaml } = await readStack(serverId);
  return describeStackCertificates(yaml);
}

/** The certificates in a host's stack file, described. Pure, so no second dial. */
export function describeStackCertificates(
  stackYaml: string,
): ServerCertificate[] {
  return describeAll(traefikCertificates(stackYaml));
}

/** Describe a host's certificates, skipping any Deplo cannot read. */
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

// Install a certificate on a server. One that merely overlaps is kept alongside.
export async function addServerCertificate(
  serverId: string,
  input: CertificateInput,
): Promise<ServerCertificate[]> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  // Validated BEFORE the host is dialed: a bad PEM must not come back as "server unreachable".
  const added = parseCertificate(input);
  const description = describe(added);
  const covered = new Set(description.domains);

  const { withTraefikStackLock } =
    await import("../infra/agent-client/host-ops");
  const { next, serverName } = await withTraefikStackLock(
    serverId,
    async () => {
      const { server, yaml } = await readStack(serverId);
      const current = traefikCertificates(yaml);
      const kept = [
        ...current.filter((c) => {
          const d = identify(c);
          return !d || !supersedes(covered, d);
        }),
        added,
      ];
      await applyCertificates(serverId, server.name, yaml, kept);
      return { next: kept, serverName: server.name };
    },
  );

  await recordActivity(
    "server",
    `Installed a TLS certificate for ${description.domains.join(", ")} on ${serverName}`,
    user.name,
    null,
    teamId,
  );
  return describeAll(next);
}

/** Remove one certificate by fingerprint; the proxy falls back to whatever else covers it. */
export async function removeServerCertificate(
  serverId: string,
  certificateId: string,
): Promise<ServerCertificate[]> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const { withTraefikStackLock } =
    await import("../infra/agent-client/host-ops");
  const { next, removed, serverName } = await withTraefikStackLock(
    serverId,
    async () => {
      const { server, yaml } = await readStack(serverId);
      const current = traefikCertificates(yaml);
      const target = current.find((c) => identify(c)?.id === certificateId);
      if (!target)
        throw new Error(`That certificate is not installed on ${server.name}`);
      const kept = current.filter((c) => c !== target);
      await applyCertificates(serverId, server.name, yaml, kept);
      return {
        next: kept,
        removed:
          identify(target)?.domains.join(", ") ?? "an unreadable certificate",
        serverName: server.name,
      };
    },
  );

  await recordActivity(
    "server",
    `Removed the TLS certificate for ${removed} from ${serverName}`,
    user.name,
    null,
    teamId,
  );
  return describeAll(next);
}

/** The server row plus its live Traefik stack file, refusing a proxy Deplo did not install. */
async function readStack(serverId: string) {
  const server = await getServerById(serverId);
  if (!server) throw new Error("Server not found");
  const { fetchHostInfo } = await import("../infra/agent-client/host-ops");
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
  const { applyTraefikConfig } = await import("../infra/agent-client/host-ops");
  const composeYaml = withTraefikCertificates(currentYaml, certificates);
  // Applying recreates the proxy and takes every site on the host down for a few seconds.
  if (composeYaml === currentYaml) return;
  const res = await applyTraefikConfig(serverId, { composeYaml });
  if (!res.ok)
    throw new Error(
      addComposeHint(
        res.error || `Could not apply the certificate on ${serverName}`,
      ),
    );
}

// The certificate rides in an inline compose `configs` entry, which needs Compose 2.23.1.
function addComposeHint(error: string): string {
  return /config/i.test(error)
    ? `${error} Installing a certificate needs Docker Compose 2.23.1 or newer on that server.`
    : error;
}

// Read and check a pasted certificate + key.
function parseCertificate(input: CertificateInput): CustomCertificate {
  const certPem = input.certPem.trim();
  const keyPem = input.keyPem.trim();
  if (!certPem.includes("BEGIN CERTIFICATE"))
    throw new Error(
      "That is not a certificate. Paste the PEM text, starting with -----BEGIN CERTIFICATE-----",
    );

  // Traefik serves the FIRST certificate in the file and treats the rest as the chain.
  const chain = splitChain(certPem);
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(chain[0]);
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
  if (!cert.checkPrivateKey(key)) {
    // A key matching a LATER certificate means the chain was pasted upside down.
    if (chain.slice(1).some((pem) => matchesKey(pem, key)))
      throw new Error(
        "That chain is upside down. Put your own certificate first and the intermediates after it.",
      );
    throw new Error("That private key does not belong to that certificate");
  }

  const notAfter = new Date(cert.validTo);
  if (notAfter.getTime() < Date.now())
    throw new Error(
      `That certificate expired on ${notAfter.toISOString().slice(0, 10)}. Renew it and upload the new one.`,
    );
  // Refused like an expired one: Traefik would serve it and every browser would reject it.
  const notBefore = new Date(cert.validFrom);
  if (notBefore.getTime() > Date.now())
    throw new Error(
      `That certificate is not valid until ${notBefore.toISOString().slice(0, 10)}. Install it on or after that date.`,
    );

  // Trailing newline: PEM files carry one, and some readers are fussy about it.
  return { certPem: `${certPem}\n`, keyPem: `${keyPem}\n` };
}

/** The PEM blocks in a chain file, in order. */
function splitChain(pem: string): string[] {
  const end = "-----END CERTIFICATE-----";
  return pem
    .split(end)
    .map((part) => `${part}${end}`)
    .filter((part) => part.includes("BEGIN CERTIFICATE"));
}

/** Whether this PEM's certificate was issued for `key`. Unreadable ⇒ no. */
function matchesKey(
  pem: string,
  key: ReturnType<typeof createPrivateKey>,
): boolean {
  try {
    return new X509Certificate(pem).checkPrivateKey(key);
  } catch {
    return false;
  }
}

// Whether a certificate covering `incoming` makes `installed` redundant; a partial overlap does not.
// Evicting an overlap would drop the names only it covers, and Traefik prefers the more specific certificate per hostname.
export function supersedes(
  incoming: Set<string>,
  installed: ServerCertificate,
): boolean {
  return (
    installed.domains.length > 0 &&
    installed.domains.every((name) => incoming.has(name))
  );
}

/** Describe an installed certificate. Never touches the key. */
function describe(certificate: CustomCertificate): ServerCertificate {
  const cert = new X509Certificate(certificate.certPem);
  const cn = subjectCommonName(cert.subject);
  const domains = subjectAltNames(cert.subjectAltName);
  // `validFrom`/`validTo` rather than the Date pair: every Node version carries the strings.
  const notBefore = new Date(cert.validFrom);
  const notAfter = new Date(cert.validTo);
  const msLeft = notAfter.getTime() - Date.now();
  return {
    id: cert.fingerprint256,
    subject: cn || domains[0] || "Unnamed certificate",
    domains: domains.length > 0 ? domains : cn ? [cn] : [],
    issuer:
      subjectCommonName(cert.issuer) ||
      cert.issuer.split("\n")[0] ||
      "Unknown issuer",
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

/** `subjectAltName` is `DNS:a, DNS:*.b, IP Address:x`: only the DNS entries are hostnames. */
function subjectAltNames(altName: string | undefined): string[] {
  if (!altName) return [];
  return altName
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("DNS:"))
    .map((part) => part.slice(4).trim())
    .filter(Boolean);
}
