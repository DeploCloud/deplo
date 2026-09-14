import "server-only";

import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { PREVIEW_TTL_DAYS_DEFAULT } from "./settings";
import { SLOTLESS } from "./slots";
import { teardownPreviewStack } from "./stack-teardown";

// Previews the reaper should act on, in two disjoint sets: `retry` - stopped but never
// verifiably torn down, because the agent was down; `expired` - open, and idle past the
// app's TTL.
export async function previewsDueForReaping(
  now: Date,
  limit: number,
): Promise<{
  retry: { id: string; deployKey: string; tornDownAt: string | null }[];
  expired: { id: string; prNumber: number }[];
}> {
  const retry = await getDb()
    .select({
      id: appPreviewsTable.id,
      deployKey: appPreviewsTable.deployKey,
      tornDownAt: appPreviewsTable.tornDownAt,
    })
    .from(appPreviewsTable)
    .where(
      and(
        isNull(appPreviewsTable.tornDownAt),
        or(
          eq(appPreviewsTable.state, "closed"),
          // A row that never built has nothing on any host, so it is not a retry.
          and(
            inArray(appPreviewsTable.status, [...SLOTLESS]),
            isNotNull(appPreviewsTable.latestDeploymentId),
          ),
        ),
      ),
    )
    .limit(limit);

  // The TTL lives on the APP (NULL ⇒ the default), so the comparison is done in
  // SQL against a coalesced interval rather than by loading every app.
  const expired = await getDb()
    .select({ id: appPreviewsTable.id, prNumber: appPreviewsTable.prNumber })
    .from(appPreviewsTable)
    .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
    .where(
      and(
        eq(appPreviewsTable.state, "open"),
        sql`${appPreviewsTable.lastActivityAt} < ${now.toISOString()}::timestamptz
            - (coalesce(nullif(${appsTable.previewTtlDays}, 0), ${PREVIEW_TTL_DAYS_DEFAULT}) * interval '1 day')`,
      ),
    )
    .limit(limit);

  return { retry, expired };
}

// Finish a teardown the reaper picked up, unless the row moved on since: a Redeploy or
// an approval in between made it `queued`, and its stack is now the one being built.
export async function retryPreviewTeardown(
  previewId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({
      id: appPreviewsTable.id,
      deployKey: appPreviewsTable.deployKey,
      tornDownAt: appPreviewsTable.tornDownAt,
      state: appPreviewsTable.state,
      status: appPreviewsTable.status,
    })
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  const p = rows[0];
  if (!p) return true;
  const stopped =
    p.state === "closed" || (SLOTLESS as readonly string[]).includes(p.status);
  if (!stopped) return false;
  return teardownPreviewStack(p);
}

// How long a closed pull request keeps its row in the list.
export const PREVIEW_CLOSED_RETENTION_DAYS = 7;

// Drop the rows of pull requests closed long enough ago, once their stack is confirmed
// gone. A row is the only proof a stack exists, so one whose teardown never succeeded
// is kept whatever its age.
export async function pruneClosedPreviews(
  now: Date,
  limit: number,
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - PREVIEW_CLOSED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const stale = await getDb()
    .select({ id: appPreviewsTable.id })
    .from(appPreviewsTable)
    .where(
      and(
        eq(appPreviewsTable.state, "closed"),
        isNotNull(appPreviewsTable.tornDownAt),
        sql`${appPreviewsTable.closedAt} < ${cutoff}::timestamptz`,
      ),
    )
    .limit(limit);
  if (stale.length === 0) return 0;
  await getDb()
    .delete(appPreviewsTable)
    .where(
      inArray(
        appPreviewsTable.id,
        stale.map((r) => r.id),
      ),
    );
  return stale.length;
}

// Open previews whose pull request should be re-checked against GitHub - the
// missed-`closed`-webhook safety net. Oldest-checked first, so a batch per tick covers
// everything eventually.
export async function openPreviewsForStateCheck(limit: number): Promise<
  {
    id: string;
    appId: string;
    prNumber: number;
    installationId: string | null;
    repo: string | null;
  }[]
> {
  return getDb()
    .select({
      id: appPreviewsTable.id,
      appId: appPreviewsTable.appId,
      prNumber: appPreviewsTable.prNumber,
      installationId: appsTable.repoInstallationId,
      repo: appsTable.repoRepo,
    })
    .from(appPreviewsTable)
    .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
    .where(
      and(
        eq(appPreviewsTable.state, "open"),
        eq(appsTable.source, "github"),
        ne(appsTable.repoRepo, ""),
      ),
    )
    .orderBy(appPreviewsTable.updatedAt)
    .limit(limit);
}
