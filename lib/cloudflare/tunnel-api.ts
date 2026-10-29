import "server-only";

import type { TunnelIngressRule } from "../deploy/panel-tunnel-stack";

const API = "https://api.cloudflare.com/client/v4";
export const TUNNEL_TARGET_SUFFIX = ".cfargotunnel.com";

type Envelope<T> = {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
};

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function cf<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new CloudflareError(
      `Deplo could not reach Cloudflare (${e instanceof Error ? e.message : String(e)})`,
      0,
    );
  }
  let parsed: Envelope<T> | null = null;
  try {
    parsed = (await res.json()) as Envelope<T>;
  } catch {
    parsed = null;
  }
  if (res.ok && parsed?.success !== false && parsed) return parsed.result as T;
  const reason = parsed?.errors?.[0]?.message?.trim();
  if (res.status === 401 || res.status === 403)
    throw new CloudflareError(
      `Cloudflare refused the API token${reason ? `: ${reason}` : ""}. It needs Cloudflare Tunnel and DNS edit access.`,
      res.status,
    );
  throw new CloudflareError(
    `Cloudflare answered ${res.status}${reason ? `: ${reason}` : ""}`,
    res.status,
  );
}

export type CloudflareZone = { id: string; name: string; accountId: string };

/** The zone the hostname lives in: the longest suffix of it this token can see. */
export async function findZone(
  token: string,
  hostname: string,
): Promise<CloudflareZone> {
  const labels = hostname.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join(".");
    const zones = await cf<
      { id: string; name: string; account?: { id?: string } }[]
    >(token, "GET", `/zones?name=${encodeURIComponent(name)}`);
    const zone = zones?.find((z) => z.name === name && z.account?.id);
    if (zone)
      return { id: zone.id, name: zone.name, accountId: zone.account!.id! };
  }
  throw new Error(
    `${hostname} is not in a domain this Cloudflare token can reach. Add the domain to Cloudflare, or give the token access to it.`,
  );
}

export async function createTunnel(
  token: string,
  accountId: string,
  name: string,
): Promise<string> {
  const res = await cf<{ id: string }>(
    token,
    "POST",
    `/accounts/${accountId}/cfd_tunnel`,
    { name, config_src: "cloudflare" },
  );
  if (!res?.id) throw new Error("Cloudflare did not return the new tunnel");
  return res.id;
}

export async function tunnelToken(
  token: string,
  accountId: string,
  tunnelId: string,
): Promise<string> {
  const res = await cf<string>(
    token,
    "GET",
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
  );
  if (typeof res !== "string" || !res)
    throw new Error("Cloudflare did not return the tunnel's token");
  return res;
}

export async function setTunnelIngress(
  token: string,
  accountId: string,
  tunnelId: string,
  ingress: TunnelIngressRule[],
): Promise<void> {
  await cf(
    token,
    "PUT",
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
    { config: { ingress } },
  );
}

export type TunnelHealth = {
  status: "healthy" | "degraded" | "down" | "inactive" | "unknown";
  connections: number;
};

export async function tunnelHealth(
  token: string,
  accountId: string,
  tunnelId: string,
): Promise<TunnelHealth> {
  const res = await cf<{ status?: string; connections?: unknown[] }>(
    token,
    "GET",
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
  );
  const status = res?.status;
  return {
    status:
      status === "healthy" ||
      status === "degraded" ||
      status === "down" ||
      status === "inactive"
        ? status
        : "unknown",
    connections: Array.isArray(res?.connections) ? res.connections.length : 0,
  };
}

/** Deletes the tunnel, dropping whatever connections Cloudflare still holds for it first. */
export async function deleteTunnel(
  token: string,
  accountId: string,
  tunnelId: string,
): Promise<void> {
  const base = `/accounts/${accountId}/cfd_tunnel/${tunnelId}`;
  try {
    await cf(token, "DELETE", `${base}/connections`);
  } catch (e) {
    if (!(e instanceof CloudflareError && e.status === 404)) throw e;
  }
  try {
    await cf(token, "DELETE", base);
  } catch (e) {
    if (!(e instanceof CloudflareError && e.status === 404)) throw e;
  }
}

export type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
};

export async function dnsRecords(
  token: string,
  zoneId: string,
  name: string,
): Promise<DnsRecord[]> {
  const res = await cf<DnsRecord[]>(
    token,
    "GET",
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
  );
  return (res ?? []).filter((r) => r.name.toLowerCase() === name);
}

export async function deleteDnsRecord(
  token: string,
  zoneId: string,
  id: string,
): Promise<void> {
  try {
    await cf(token, "DELETE", `/zones/${zoneId}/dns_records/${id}`);
  } catch (e) {
    if (!(e instanceof CloudflareError && e.status === 404)) throw e;
  }
}

export async function createDnsRecord(
  token: string,
  zoneId: string,
  record: Omit<DnsRecord, "id"> & { comment?: string },
): Promise<string> {
  const res = await cf<{ id: string }>(
    token,
    "POST",
    `/zones/${zoneId}/dns_records`,
    record,
  );
  if (!res?.id) throw new Error("Cloudflare did not return the new DNS record");
  return res.id;
}

export type PointedRecord = {
  id: string;
  /** What this replaced, so a failed setup can put it back. */
  replaced: DnsRecord[];
  created: boolean;
};

/**
 * Points `name` at the tunnel. Replaces only records Deplo can account for (`ours`);
 * anything else on that name is someone's site, and is refused rather than deleted.
 */
export async function pointAtTunnel(
  token: string,
  zoneId: string,
  name: string,
  tunnelId: string,
  ours: (record: DnsRecord) => boolean,
): Promise<PointedRecord> {
  const target = `${tunnelId}${TUNNEL_TARGET_SUFFIX}`;
  const existing = await dnsRecords(token, zoneId, name);
  const kept = existing.find(
    (r) => r.type === "CNAME" && r.content.toLowerCase() === target,
  );
  if (kept) return { id: kept.id, replaced: [], created: false };

  const foreign = existing.filter((r) => !ours(r));
  if (foreign.length > 0)
    throw new Error(
      `${name} already has a ${foreign[0].type} record in Cloudflare (${foreign[0].content}). Pick an address nothing else uses, or delete that record first.`,
    );
  for (const r of existing) await deleteDnsRecord(token, zoneId, r.id);
  try {
    const id = await createDnsRecord(token, zoneId, {
      type: "CNAME",
      name,
      content: target,
      proxied: true,
      ttl: 1,
      comment: "Deplo panel",
    });
    return { id, replaced: existing, created: true };
  } catch (e) {
    await restoreDnsRecords(token, zoneId, existing);
    throw e;
  }
}

export async function restoreDnsRecords(
  token: string,
  zoneId: string,
  records: DnsRecord[],
): Promise<void> {
  for (const r of records) {
    try {
      await createDnsRecord(token, zoneId, {
        type: r.type,
        name: r.name,
        content: r.content,
        proxied: r.proxied,
        ttl: r.ttl ?? 1,
      });
    } catch {}
  }
}
