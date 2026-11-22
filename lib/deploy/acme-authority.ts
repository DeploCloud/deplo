import { readFileSync } from "node:fs";

import { isMap, isSeq } from "yaml";

import {
  addTo,
  dropOurConfig,
  dump,
  entryName,
  listOf,
  parseCompose,
  scalar,
  setList,
  traefikService,
} from "./traefik-compose";

// Every proxy orders its certificates from the authority Deplo names, never the one its file says (ADR-0050).

/** The ACME directory and, for a test one, the root it is served under. Null directory: Let's Encrypt. */
export interface AcmeAuthority {
  directory: string | null;
  caPem: string | null;
}

export const ACME_CA_CONFIG = "deplo-acme-ca";
const ACME_CA_TARGET = "/deplo-acme-ca.pem";
const CA_ENV = "LEGO_CA_CERTIFICATES";

/** Let's Encrypt, unless this Deplo runs in its certificate test mode (`DEPLO_TEST_ACME_DIRECTORY`). */
export function acmeAuthority(
  env: Record<string, string | undefined> = process.env,
): AcmeAuthority {
  const directory = env.DEPLO_TEST_ACME_DIRECTORY?.trim();
  if (!directory) return { directory: null, caPem: null };
  if (!/^https:\/\//.test(directory))
    throw new Error("DEPLO_TEST_ACME_DIRECTORY must be an https:// address");
  const file = env.DEPLO_TEST_ACME_CA?.trim();
  return { directory, caPem: file ? readFileSync(file, "utf8") : null };
}

const RESOLVER_FLAG =
  /^--certificatesresolvers\.([^.=]+)\.acme\.([a-z]+)=(.*)$/;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/**
 * Points every resolver of the proxy at the authority: its caserver, a test duration only for a test authority, and
 * the root the proxy trusts for it. Answers null when the file already says so.
 */
export function withAcmeAuthority(
  currentYaml: string,
  a: AcmeAuthority,
): string | null {
  const doc = parseCompose(currentYaml);
  const before = dump(doc);
  const service = traefikService(doc);
  const command = listOf(service.get("command", true));
  const resolvers = new Set<string>();
  const leftHosts = new Set<string>();
  const kept = command.filter((c) => {
    const m = c.match(RESOLVER_FLAG);
    if (!m) return true;
    if (m[2] === "storage") resolvers.add(m[1]);
    if (m[2] === "caserver") {
      leftHosts.add(hostOf(m[3]));
      return false;
    }
    return m[2] !== "certificatesduration" || a.directory !== null;
  });
  if (a.directory)
    for (const r of resolvers)
      kept.push(`--certificatesresolvers.${r}.acme.caserver=${a.directory}`);
  setList(doc, service, "command", kept);
  if (a.directory) leftHosts.delete(hostOf(a.directory));

  // The root a resolver's old authority was trusted under goes with it, mounted or written by Deplo.
  const envNode = service.get("environment", true);
  const roots = listOf(envNode)
    .filter((e) => entryName(e) === CA_ENV)
    .flatMap((e) => e.slice(CA_ENV.length + 1).split(/[,:]/));
  if (isMap(envNode)) envNode.delete(CA_ENV);
  else
    setList(
      doc,
      service,
      "environment",
      listOf(envNode).filter((e) => entryName(e) !== CA_ENV),
    );
  const volumes = service.get("volumes", true);
  if (isSeq(volumes)) {
    volumes.items = volumes.items.filter((v) => {
      const target = isMap(v)
        ? scalar(v.get("target", true))
        : (scalar(v).split(":")[1] ?? "");
      return !roots.includes(target);
    });
    if (volumes.items.length === 0) service.delete("volumes");
  }
  dropOurConfig(doc, service, ACME_CA_CONFIG);
  if (a.directory && a.caPem) {
    const env = service.get("environment", true);
    if (isMap(env)) env.set(CA_ENV, ACME_CA_TARGET);
    else addTo(doc, service, "environment", `${CA_ENV}=${ACME_CA_TARGET}`);
    addTo(doc, service, "configs", {
      source: ACME_CA_CONFIG,
      target: ACME_CA_TARGET,
    });
    doc.setIn(
      ["configs", ACME_CA_CONFIG],
      doc.createNode({ content: a.caPem }),
    );
  }

  const hosts = service.get("extra_hosts", true);
  if (isSeq(hosts)) {
    hosts.items = hosts.items.filter(
      (h) => !leftHosts.has(scalar(h).split(/[:=]/)[0].trim()),
    );
    if (hosts.items.length === 0) service.delete("extra_hosts");
  }
  const next = dump(doc);
  return next === before ? null : next;
}
