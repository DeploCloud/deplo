import "server-only";

import { and, count, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { assertLetsencryptQuota } from "../../deploy/domains";
import type { CertProvider } from "../../types/domain";

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
