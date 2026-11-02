import "server-only";

import { and, eq, isNull, or } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  OFFLINE_PAGE_HEADER,
  certProviderForMode,
  cloudflareModeFrom,
  type CloudflareMode,
} from "../../deploy/cloudflare";
import { rerouteApp } from "../../deploy/build/reroute";
import { assertSafeOutboundUrl } from "../../outbound-url";
import type { CertProvider } from "../../types/domain";
import { mapLimit } from "../../utils";
import { recordActivity, type ActivityActor } from "../activity";
import { certProviderWithinQuota } from "./letsencrypt-quota";
import { syncProductionUrl } from "./primary-domain";

const PROBE_TIMEOUT_MS = 8_000;

export async function probeCloudflareMode(
  name: string,
  pathPrefix?: string | null,
): Promise<CloudflareMode | null> {
  const url = new URL(pathPrefix || "/", `https://${name}`).href;
  try {
    await assertSafeOutboundUrl(url, "Domain");
    const res = await fetch(url, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return cloudflareModeFrom(url, {
      status: res.status,
      location: res.headers.get("location"),
      offlinePage: res.headers.has(OFFLINE_PAGE_HEADER),
    });
  } catch {
    return null;
  }
}

interface ProbedDomain {
  name: string;
  pathPrefix?: string | null;
  certProvider?: CertProvider | null;
}

// Reads the LIVE route, so call it only once Cloudflare already routes to the stored provider.
export async function certProviderForCloudflare(
  dom: ProbedDomain,
  teamId: string,
): Promise<{
  certProvider: CertProvider | undefined;
  mode: CloudflareMode | null;
}> {
  const current = dom.certProvider ?? undefined;
  const mode = await probeCloudflareMode(dom.name, dom.pathPrefix);
  const next = certProviderForMode(current, mode);
  if (next === current || next !== "letsencrypt")
    return { certProvider: next, mode };
  // Past the team's cap, Cloudflare's own HTTPS is the next best thing that works under Full.
  return {
    certProvider:
      (await certProviderWithinQuota(teamId, next)) === next
        ? next
        : "cloudflare",
    mode,
  };
}

const PROVIDER_LABEL: Record<CertProvider, string> = {
  none: "no certificate",
  letsencrypt: "Let's Encrypt",
  cloudflare: "Cloudflare",
  custom: "the certificate installed on the server",
};

const MODE_REASON: Record<CloudflareMode, string> = {
  flexible: "Cloudflare reaches the server over plain HTTP (Flexible)",
  full: "Cloudflare reaches the server over HTTPS (Full)",
  strict: "Cloudflare asks the server for a valid certificate (Full strict)",
};

export async function recordCertificateSwitch(
  name: string,
  certProvider: CertProvider | undefined,
  mode: CloudflareMode | null,
  actor: ActivityActor,
  appId: string,
  teamId: string | null = null,
): Promise<void> {
  const reason = mode ? ` - ${MODE_REASON[mode]}` : "";
  await recordActivity(
    "domain",
    `Switched ${name} to ${PROVIDER_LABEL[certProvider ?? "letsencrypt"]}${reason}`,
    actor,
    appId,
    teamId,
  );
}

// https://deplo.build/docs/guides/networking/domains-and-https
export async function sweepCloudflareCertificates(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({
      id: domainsTable.id,
      name: domainsTable.name,
      appId: domainsTable.appId,
      pathPrefix: domainsTable.pathPrefix,
      certProvider: domainsTable.certProvider,
      teamId: appsTable.teamId,
    })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(
      and(
        eq(domainsTable.status, "cloudflare"),
        or(isNull(domainsTable.tunnel), eq(domainsTable.tunnel, false)),
      ),
    );

  const changed = new Set<string>();
  await mapLimit(rows, 4, async (row) => {
    try {
      const current = (row.certProvider ?? undefined) as
        CertProvider | undefined;
      const { certProvider, mode } = await certProviderForCloudflare(
        { ...row, certProvider: current },
        row.teamId,
      );
      if (certProvider === current) return;
      await db
        .update(domainsTable)
        .set({ certProvider: certProvider ?? null })
        .where(eq(domainsTable.id, row.id));
      changed.add(row.appId);
      await recordCertificateSwitch(
        row.name,
        certProvider,
        mode,
        "Deplo",
        row.appId,
        row.teamId,
      );
    } catch (e) {
      console.warn(`[deplo] cloudflare probe failed for ${row.name}:`, e);
    }
  });
  for (const appId of changed) {
    try {
      await syncProductionUrl(appId);
      await rerouteApp(appId);
    } catch (e) {
      console.warn(`[deplo] cloudflare reroute failed for ${appId}:`, e);
    }
  }
}
