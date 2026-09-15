import { parseEnvBlob } from "../../map/env";
import type { SourceDomain } from "../../model";

function composeDomainPairs(
  raw: string | null | undefined,
): [string, string][] {
  const text = raw?.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: [string, string][] = [];
  const add = (name: unknown, domain: unknown) => {
    if (typeof name === "string" && typeof domain === "string" && domain.trim())
      out.push([name, domain]);
  };
  if (Array.isArray(parsed))
    for (const e of parsed) {
      const r = e as { name?: unknown; domain?: unknown };
      add(r?.name, r?.domain);
    }
  else if (parsed && typeof parsed === "object")
    for (const [name, v] of Object.entries(parsed as Record<string, unknown>))
      add(name, (v as { domain?: unknown })?.domain ?? v);
  return out;
}

export function parseCoolifyFqdns(
  fqdn: string | null | undefined,
  perService?: string | null,
  extra: { url: string; service: string | null; port?: number | null }[] = [],
  onCompose?: { service: string | null; port: number | null },
): { value: SourceDomain[]; notes: string[] } {
  const entries: {
    url: string;
    service: string | null;
    port?: number | null;
  }[] = [];
  for (const raw of (fqdn ?? "").split(","))
    if (raw.trim())
      entries.push({
        url: raw.trim(),
        service: onCompose?.service ?? null,
        port: onCompose?.port ?? null,
      });
  for (const [service, domains] of composeDomainPairs(perService))
    for (const raw of domains.split(","))
      if (raw.trim()) entries.push({ url: raw.trim(), service });
  entries.push(...extra);

  const merged = new Map<string, { domain: SourceDomain; said: boolean }>();
  for (const [i, e] of entries.entries()) {
    const said = /^https?:\/\//i.exec(e.url)?.[0] ?? "";
    let u: URL;
    try {
      u = new URL(said ? e.url : `http://${e.url}`);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    if (!host) continue;
    const path = u.pathname === "/" ? null : u.pathname.replace(/\/+$/, "");
    const key = `${host}${path ?? ""}${e.service ?? ""}`;
    const https = /^https/i.test(said);
    const port = u.port ? Number(u.port) : (e.port ?? null);

    const already = merged.get(key);
    if (already) {
      if (already.domain.port == null && port != null)
        already.domain.port = port;
      if (!already.said && said) {
        already.said = true;
        already.domain.https = https;
        already.domain.certificateType = https ? "letsencrypt" : "none";
      }
      continue;
    }

    merged.set(key, {
      said: Boolean(said),
      domain: {
        domainId: `cool-fqdn-${i}`,
        host,
        https,
        port,
        path,
        stripPath: false,
        internalPath: null,
        serviceName: e.service,
        customEntrypoint: null,
        domainType: e.service ? "compose" : "application",
        certificateType: https ? "letsencrypt" : "none",
        enabled: true,
      },
    });
  }

  const notes: string[] = [];
  for (const { domain, said } of merged.values())
    if (!said)
      notes.push(
        `{panel} recorded ${domain.host} without http:// or https://, so it comes across on plain http exactly as it answered there. Add a certificate under Domains to serve it over https.`,
      );
  return { value: [...merged.values()].map((r) => r.domain), notes };
}

const SERVICE_FQDN_KEY = /^SERVICE_FQDN_(.+?)(?:_(\d+))?$/;

export function coolifyServiceFqdns(
  env: string | null | undefined,
  serviceNames: string[],
): { url: string; service: string | null; port: number | null }[] {
  const bare = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byBare = new Map(serviceNames.map((n) => [bare(n), n]));
  const out: { url: string; service: string | null; port: number | null }[] =
    [];
  for (const { key, value } of parseEnvBlob(env)) {
    const m = SERVICE_FQDN_KEY.exec(key);
    if (!m || !value.trim()) continue;
    const port = m[2] ? Number(m[2]) : null;
    out.push({
      url: value.trim(),
      service: byBare.get(bare(m[1])) ?? null,
      port: Number.isFinite(port) && port ? port : null,
    });
  }
  return out;
}
