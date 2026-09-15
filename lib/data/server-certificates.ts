import "server-only";

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

export type ServerCertificate = {
  id: string;
  subject: string;
  domains: string[];
  issuer: string;
  notBefore: string;
  notAfter: string;
  expired: boolean;
  expiresInDays: number;
};

export type CertificateInput = { certPem: string; keyPem: string };

export async function listServerCertificates(
  serverId: string,
): Promise<ServerCertificate[]> {
  await requireInstanceAdmin();
  const { yaml } = await readStack(serverId);
  return describeStackCertificates(yaml);
}

export function describeStackCertificates(
  stackYaml: string,
): ServerCertificate[] {
  return describeAll(traefikCertificates(stackYaml));
}

function describeAll(certificates: CustomCertificate[]): ServerCertificate[] {
  return certificates.flatMap((c) => {
    try {
      return [describe(c)];
    } catch {
      return [];
    }
  });
}

function identify(certificate: CustomCertificate): ServerCertificate | null {
  try {
    return describe(certificate);
  } catch {
    return null;
  }
}

export async function addServerCertificate(
  serverId: string,
  input: CertificateInput,
): Promise<ServerCertificate[]> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

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
  if (composeYaml === currentYaml) return;
  const res = await applyTraefikConfig(serverId, { composeYaml });
  if (!res.ok)
    throw new Error(
      addComposeHint(
        res.error || `Could not apply the certificate on ${serverName}`,
      ),
    );
}

function addComposeHint(error: string): string {
  return /config/i.test(error)
    ? `${error} Installing a certificate needs Docker Compose 2.23.1 or newer on that server.`
    : error;
}

function parseCertificate(input: CertificateInput): CustomCertificate {
  const certPem = input.certPem.trim();
  const keyPem = input.keyPem.trim();
  if (!certPem.includes("BEGIN CERTIFICATE"))
    throw new Error(
      "That is not a certificate. Paste the PEM text, starting with -----BEGIN CERTIFICATE-----",
    );

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
  const notBefore = new Date(cert.validFrom);
  if (notBefore.getTime() > Date.now())
    throw new Error(
      `That certificate is not valid until ${notBefore.toISOString().slice(0, 10)}. Install it on or after that date.`,
    );

  return { certPem: `${certPem}\n`, keyPem: `${keyPem}\n` };
}

function splitChain(pem: string): string[] {
  const end = "-----END CERTIFICATE-----";
  return pem
    .split(end)
    .map((part) => `${part}${end}`)
    .filter((part) => part.includes("BEGIN CERTIFICATE"));
}

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

export function supersedes(
  incoming: Set<string>,
  installed: ServerCertificate,
): boolean {
  return (
    installed.domains.length > 0 &&
    installed.domains.every((name) => incoming.has(name))
  );
}

function describe(certificate: CustomCertificate): ServerCertificate {
  const cert = new X509Certificate(certificate.certPem);
  const cn = subjectCommonName(cert.subject);
  const domains = subjectAltNames(cert.subjectAltName);
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

function subjectCommonName(subject: string): string {
  for (const line of subject.split("\n")) {
    if (line.startsWith("CN=")) return line.slice(3).trim();
  }
  return "";
}

function subjectAltNames(altName: string | undefined): string[] {
  if (!altName) return [];
  return altName
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("DNS:"))
    .map((part) => part.slice(4).trim())
    .filter(Boolean);
}
