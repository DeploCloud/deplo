import "server-only";

import { and, asc, eq, notInArray, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { publishAppChanged } from "../../graphql/pubsub";
import { syncPreviewComment } from "../preview-comment";
import { stopPreview } from "./stack-teardown";

// The statuses that hold NO slot against the cap, because neither has a stack:
// `blocked` was never cloned or built, `evicted` had its stack removed.
export const SLOTLESS = ["blocked", "evicted"] as const;

// A preview whose containers may still be on a host: built at least once, and never
// confirmed gone.
export function hasStack(p: {
  status: string;
  tornDownAt: string | null;
  latestDeploymentId: string | null;
}): boolean {
  return (
    !p.tornDownAt &&
    Boolean(p.latestDeploymentId) &&
    !(SLOTLESS as readonly string[]).includes(p.status)
  );
}

// How many previews of this app are currently open (the cap's subject).
export async function countOpenPreviews(appId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(appPreviewsTable)
    .where(
      and(
        eq(appPreviewsTable.appId, appId),
        eq(appPreviewsTable.state, "open"),
        // The cap counts STACKS, not rows.
        notInArray(appPreviewsTable.status, [...SLOTLESS]),
      ),
    );
  return rows[0]?.n ?? 0;
}

// Make room for one more preview by tearing down the least recently active ones until
// the app is back under `keep`. `max` is the limit the pull request is told.
export async function evictToFit(
  appId: string,
  keep: number,
  max: number,
): Promise<number> {
  const victims = await getDb()
    .select({
      id: appPreviewsTable.id,
      deployKey: appPreviewsTable.deployKey,
      tornDownAt: appPreviewsTable.tornDownAt,
    })
    .from(appPreviewsTable)
    .where(
      and(
        eq(appPreviewsTable.appId, appId),
        eq(appPreviewsTable.state, "open"),
        notInArray(appPreviewsTable.status, [...SLOTLESS]),
      ),
    )
    .orderBy(asc(appPreviewsTable.lastActivityAt))
    .limit(Math.max(0, (await countOpenPreviews(appId)) - keep + 1));

  for (const v of victims) {
    await stopPreview(v, "evicted");
    // The link on the pull request just went dead; say so where it was posted.
    void syncPreviewComment(v.id, { kind: "evicted", max });
  }
  if (victims.length > 0) publishAppChanged(appId);
  return victims.length;
}
