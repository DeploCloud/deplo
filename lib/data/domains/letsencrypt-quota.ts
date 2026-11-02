import "server-only";

import { and, count, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { certProviderForDns } from "../../deploy/cloudflare";
import { assertLetsencryptQuota } from "../../deploy/domains";
import type { CertProvider, DomainStatus } from "../../types/domain";

// The whole fleet shares ONE ACME account, so an uncapped tenant exhausts the rate limit for every other team.
export async function assertTeamLetsencryptQuota(
  teamId: string,
  provider: CertProvider,
): Promise<void> {
  if (provider !== "letsencrypt") return;
  const [domains, previews] = await Promise.all([
    getDb()
      .select({ n: count() })
      .from(domainsTable)
      .innerJoin(appsTable, eq(domainsTable.appId, appsTable.id))
      .where(
        and(
          eq(appsTable.teamId, teamId),
          eq(domainsTable.certProvider, "letsencrypt"),
        ),
      ),
    getDb()
      .select({ n: count() })
      .from(appPreviewsTable)
      .innerJoin(appsTable, eq(appPreviewsTable.appId, appsTable.id))
      .where(
        and(
          eq(appsTable.teamId, teamId),
          eq(appPreviewsTable.certProvider, "letsencrypt"),
          eq(appPreviewsTable.state, "open"),
        ),
      ),
  ]);
  assertLetsencryptQuota(
    (domains[0]?.n ?? 0) + (previews[0]?.n ?? 0),
    provider,
  );
}

// Past the cap a domain Cloudflare proxies keeps Cloudflare's HTTPS, which still works under Full.
export async function certProviderForDnsWithinQuota<
  T extends CertProvider | undefined,
>(
  teamId: string,
  status: DomainStatus,
  current: T,
): Promise<T | "letsencrypt" | "cloudflare"> {
  const next = certProviderForDns(status, current);
  if (next === current || next !== "letsencrypt") return current;
  return (await certProviderWithinQuota(teamId, next)) === next
    ? next
    : "cloudflare";
}

// For a writer with nobody to ask (a template, an import): past the cap the domain lands with no certificate.
export async function certProviderWithinQuota(
  teamId: string,
  provider: CertProvider,
): Promise<CertProvider> {
  return assertTeamLetsencryptQuota(teamId, provider).then(
    () => provider,
    () => "none",
  );
}
