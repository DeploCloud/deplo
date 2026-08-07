import "server-only";

import { and, asc, eq, isNull, ne, notInArray, sql } from "drizzle-orm";

import { recordActivity } from "../data/activity";
import { loadAppGraph } from "../data/app-graph-load";
import { teardownApp } from "../data/deployments";
import { withKeyedLock } from "../data/keyed-mutex";
import { getServerById } from "../data/servers";
import { getDb } from "../db/client";
import {
  apps as appsTable,
  appPreviews as appPreviewsTable,
  deployments as deploymentsTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { publishAppChanged } from "../graphql/pubsub";
import type { CertProvider } from "../types";
import { startDeployment } from "./build";
import { previewDeployKey } from "./deploy-key";
import { previewHost, resolveServerIp } from "./domains";

/**
 * The lifecycle of a **pull request preview** — open, sync, close, tear down.
 *
 * SESSION-FREE ON PURPOSE. Its three callers all run with no request identity:
 * the GitHub webhook (an inbound POST from GitHub), the reaper (a scheduler
 * tick) and the gated data layer in [previews](../data/previews.ts), which does
 * the `requireCapability` work before delegating here. A `requireCapability`
 * call inside this module would make every webhook delivery throw and be
 * silently dropped — the exact failure `runScheduledCleanup` is written to
 * avoid. Team scoping therefore happens in the CALLER; everything here is
 * store-direct and takes ids it has already been told are legitimate.
 */

/** How many previews one app may have open at once when it sets no limit. */
export const PREVIEW_MAX_ACTIVE_DEFAULT = 3;

/** Idle days before the reaper closes a preview, when the app sets no limit. */
export const PREVIEW_TTL_DAYS_DEFAULT = 3;

/** How Deplo treats a pull request opened from a fork. */
export type PreviewForkPolicy = "deny" | "approve" | "allow";

/** NULL in the column ⇒ the safe middle: visible, but never built unasked. */
export function forkPolicyOf(value: string | null | undefined): PreviewForkPolicy {
  return value === "deny" || value === "allow" ? value : "approve";
}

/** Why a pull request did NOT get a preview. Surfaced verbatim to the user. */
export type PreviewRefusal =
  | { kind: "previews-off" }
  | { kind: "not-github" }
  | { kind: "fork-denied" }
  | { kind: "awaiting-approval" }
  | { kind: "evicted"; max: number };

/** The reason, as one sentence a non-expert can act on. */
export function refusalMessage(r: PreviewRefusal): string {
  switch (r.kind) {
    case "previews-off":
      return "Pull request previews are off for this app.";
    case "not-github":
      return "Pull request previews need an app deployed from a GitHub repository.";
    case "fork-denied":
      return "This pull request comes from a fork, and this app does not build fork pull requests.";
    case "awaiting-approval":
      return "This pull request comes from a fork and needs a maintainer to approve it before it builds.";
    case "evicted":
      return `This preview was stopped to stay within the app's limit of ${r.max}. Redeploy it to bring it back.`;
  }
}

/** The pull request facts a preview is created or refreshed from. */
export interface PullRequestFacts {
  number: number;
  title: string;
  author: string;
  url: string;
  headBranch: string;
  headSha: string;
  /** `owner/name` of the head repo; differs from the app's repo ⇒ a fork. */
  headRepo: string;
  /** The fork's own clone URL — a fork's head ref does not exist on the base. */
  headCloneUrl: string;
  baseBranch: string;
  isFork: boolean;
}

export interface OpenOrSyncResult {
  previewId: string | null;
  deploymentId: string | null;
  refusal?: PreviewRefusal;
}

/**
 * Open (or refresh) the preview for one pull request and start its build.
 *
 * Everything runs under a per-pull-request lock: GitHub can deliver `opened`
 * and `synchronize` back to back, and two concurrent inserts would race the
 * `app_previews_app_pr_uq` constraint. The unique index is still the backstop —
 * the lock is only in-process.
 *
 * On INSERT the deploy key and host are minted; on UPDATE they are deliberately
 * left alone. The URL has already been commented on the pull request, so
 * regenerating it on every push would strand the link somebody is testing.
 *
 * `actor` names who caused it (a GitHub login for a webhook, a member's name for
 * a manual deploy) and is recorded on the deployment, never used for authority.
 */
export async function openOrSyncPreview(
  appId: string,
  pr: PullRequestFacts,
  opts: {
    actor: string;
    /** A manual deploy approves a fork implicitly. */
    approve?: boolean;
    /**
     * A person asked for this build, rather than a webhook delivering a push.
     * The only thing it changes: a manual deploy REVIVES an evicted preview
     * (that is what the Redeploy button is for), a webhook never does.
     */
    manual?: boolean;
  } = { actor: "github" },
): Promise<OpenOrSyncResult> {
  return withKeyedLock(`preview:${appId}:${pr.number}`, async () => {
    const app = await loadAppGraph(appId);
    if (!app) return { previewId: null, deploymentId: null };
    const settings = await previewSettings(appId);
    if (!settings) return { previewId: null, deploymentId: null };
    if (!settings.enabled) {
      return { previewId: null, deploymentId: null, refusal: { kind: "previews-off" } };
    }
    if (app.source !== "github" || !app.repo) {
      return { previewId: null, deploymentId: null, refusal: { kind: "not-github" } };
    }

    const existing = await loadPreviewRow(appId, pr.number);
    const policy = forkPolicyOf(settings.forkPolicy);
    // A fork's code is attacker-authored and would run on the operator's host.
    // `deny` never records it at all; `approve` records it so the pull request is
    // VISIBLE in the list with an approve button, but builds nothing.
    if (pr.isFork && policy === "deny" && !opts.approve) {
      return { previewId: null, deploymentId: null, refusal: { kind: "fork-denied" } };
    }
    const approved =
      !pr.isFork || policy === "allow" || opts.approve || Boolean(existing?.approvedAt);

    const now = nowIso();
    let previewId = existing?.id ?? null;
    // An evicted preview keeps taking pull request updates — its title, head SHA
    // and state stay honest in the list — but a push does NOT rebuild it. Only a
    // person clicking Redeploy does. Otherwise, with N active pull requests under
    // a cap of N, every commit would evict a sibling and the app would spend all
    // day building previews nobody asked for.
    const evictedAndUnasked = existing?.status === "evicted" && !opts.manual;
    if (existing) {
      await getDb()
        .update(appPreviewsTable)
        .set({
          prTitle: pr.title,
          prAuthor: pr.author,
          prUrl: pr.url,
          headBranch: pr.headBranch,
          headSha: pr.headSha,
          headRepo: pr.headRepo,
          headCloneUrl: pr.headCloneUrl,
          baseBranch: pr.baseBranch,
          isFork: pr.isFork,
          // Reopening a closed pull request revives the same preview, key and
          // host included — so the old link starts working again.
          state: "open",
          closedAt: null,
          tornDownAt: null,
          ...(approved && !existing.approvedAt
            ? { approvedAt: now, approvedSha: pr.headSha }
            : {}),
          ...(approved ? {} : { status: "blocked" }),
          lastActivityAt: now,
          updatedAt: now,
        })
        .where(eq(appPreviewsTable.id, existing.id));
    } else {
      // At the cap, the NEW preview wins and the least recently active one is
      // torn down. An existing preview's own next push never evicts anything —
      // it already holds its slot.
      if ((await countOpenPreviews(appId)) >= settings.maxActive) {
        await evictToFit(appId, settings.maxActive);
      }
      const server =
        (await getServerById(settings.serverId ?? app.serverId)) ?? undefined;
      const { host, certProvider } = previewHost({
        appId,
        slug: app.slug,
        prNumber: pr.number,
        baseDomain: settings.baseDomain,
        ip: resolveServerIp(server),
      });
      previewId = newId("prv");
      await getDb().insert(appPreviewsTable).values({
        id: previewId,
        appId,
        prNumber: pr.number,
        prTitle: pr.title,
        prAuthor: pr.author,
        prUrl: pr.url,
        headBranch: pr.headBranch,
        headSha: pr.headSha,
        headRepo: pr.headRepo,
        headCloneUrl: pr.headCloneUrl,
        baseBranch: pr.baseBranch,
        isFork: pr.isFork,
        approvedAt: approved ? now : null,
        approvedSha: approved ? pr.headSha : null,
        deployKey: previewDeployKey(app.slug, pr.number),
        host,
        certProvider,
        status: approved ? "queued" : "blocked",
        state: "open",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    publishAppChanged(appId);
    if (!approved) {
      return {
        previewId,
        deploymentId: null,
        refusal: { kind: "awaiting-approval" },
      };
    }
    if (evictedAndUnasked) {
      return {
        previewId,
        deploymentId: null,
        refusal: { kind: "evicted", max: settings.maxActive },
      };
    }
    const deploymentId = await deployPreviewRow(previewId!, {
      actor: opts.actor,
      commitMessage: pr.title,
    });
    return { previewId, deploymentId };
  });
}

/**
 * Queue a build for an EXISTING preview row (a resync, a manual redeploy, or the
 * first build right after an approval). Reads the row for the facts the deploy
 * needs so callers never have to assemble them.
 */
export async function deployPreviewRow(
  previewId: string,
  opts: { actor: string; commitMessage?: string },
): Promise<string | null> {
  const row = await getDb()
    .select()
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  const p = row[0];
  if (!p) return null;
  // Reviving an evicted preview reclaims a slot exactly like a new one, or the
  // app would end up over the limit it set. This lives HERE rather than in the
  // webhook path because every way back — Redeploy, approving a fork, the manual
  // pull request picker — comes through this function.
  if (p.status === "evicted") {
    const settings = await previewSettings(p.appId);
    const max = settings?.maxActive ?? PREVIEW_MAX_ACTIVE_DEFAULT;
    if ((await countOpenPreviews(p.appId)) >= max) await evictToFit(p.appId, max);
    await getDb()
      .update(appPreviewsTable)
      .set({ status: "queued", tornDownAt: null, updatedAt: nowIso() })
      .where(eq(appPreviewsTable.id, previewId));
  }
  return startDeployment(p.appId, {
    environment: "preview",
    creator: opts.actor,
    commitMessage: opts.commitMessage || p.prTitle || `Pull request #${p.prNumber}`,
    branch: p.headBranch,
    preview: {
      id: p.id,
      deployKey: p.deployKey,
      host: p.host,
      certProvider: p.certProvider as CertProvider,
      prNumber: p.prNumber,
      headSha: p.headSha,
      serverId: (await previewSettings(p.appId))?.serverId ?? null,
    },
  });
}

/**
 * Close a preview: stop accepting builds for it, cancel anything still queued,
 * and tear the stack down. Idempotent — a second call on an already-closed,
 * already-torn-down preview does nothing and reports success.
 *
 * The row is NOT deleted. `torn_down_at IS NULL` is the reaper's retry
 * predicate, and stamping it is the only proof the stack really went away; a
 * delete here would silently leak a container and a volume set the moment an
 * agent happened to be unreachable.
 */
export async function closePreview(
  previewId: string,
  reason: string,
): Promise<boolean> {
  const rows = await getDb()
    .select()
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  const p = rows[0];
  if (!p) return true;
  const now = nowIso();
  await getDb()
    .update(appPreviewsTable)
    .set({
      state: "closed",
      status: "idle",
      closedAt: p.closedAt ?? now,
      updatedAt: now,
    })
    .where(eq(appPreviewsTable.id, previewId));
  // Nothing queued for a closed pull request should ever start building.
  await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled" })
    .where(
      and(
        eq(deploymentsTable.previewId, previewId),
        eq(deploymentsTable.status, "queued"),
      ),
    );
  const gone = await teardownPreviewStack(p);
  publishAppChanged(p.appId);
  const app = await loadAppGraph(p.appId);
  await recordActivity(
    "deployment",
    gone
      ? `Destroyed the preview for pull request #${p.prNumber}${app ? ` of ${app.name}` : ""} (${reason})`
      : `Could not reach the server to destroy the preview for pull request #${p.prNumber}` +
        `${app ? ` of ${app.name}` : ""} — Deplo will retry`,
    "system",
    p.appId,
  );
  return gone;
}

/**
 * Destroy a preview's stack on its host and stamp `torn_down_at` on success.
 * Never throws: an unreachable agent leaves the stamp NULL so the reaper picks
 * the row up again, which is the whole reason the row outlives the close.
 *
 * `removeVolumes` is TRUE here, unlike an App teardown. A preview's volumes were
 * created by, and only by, that preview; nobody asked to keep their contents and
 * nothing would ever point at them again. Left behind they are one orphaned
 * volume set per closed pull request, forever, that no cleanup scope reclaims.
 */
export async function teardownPreviewStack(p: {
  id: string;
  deployKey: string;
  tornDownAt: string | null;
}): Promise<boolean> {
  if (p.tornDownAt) return true;
  const ok = await teardownApp(p.deployKey, { removeVolumes: true });
  if (ok) {
    await getDb()
      .update(appPreviewsTable)
      .set({ tornDownAt: nowIso(), updatedAt: nowIso() })
      .where(eq(appPreviewsTable.id, p.id));
  }
  return ok;
}

/**
 * Tear down every preview stack of an app, for the paths that delete the app
 * itself. MUST run before the app row goes: the FK cascade drops the preview
 * rows, and with them the only record that those containers and volumes exist.
 * Called INSIDE the app's lifecycle lock so it can't race a preview build.
 */
export async function destroyPreviewsForApp(appId: string): Promise<void> {
  const rows = await getDb()
    .select({
      id: appPreviewsTable.id,
      deployKey: appPreviewsTable.deployKey,
      tornDownAt: appPreviewsTable.tornDownAt,
    })
    .from(appPreviewsTable)
    .where(and(eq(appPreviewsTable.appId, appId), isNull(appPreviewsTable.tornDownAt)));
  for (const r of rows) {
    await teardownPreviewStack(r).catch(() => false);
  }
}

/** The effective preview settings for an app (NULL columns ⇒ the defaults). */
export async function previewSettings(appId: string): Promise<{
  enabled: boolean;
  baseDomain: string | null;
  maxActive: number;
  ttlDays: number;
  forkPolicy: PreviewForkPolicy;
  /** Where previews run. NULL ⇒ the app's own server. */
  serverId: string | null;
} | null> {
  const rows = await getDb()
    .select({
      enabled: appsTable.previewEnabled,
      baseDomain: appsTable.previewBaseDomain,
      maxActive: appsTable.previewMaxActive,
      ttlDays: appsTable.previewTtlDays,
      forkPolicy: appsTable.previewForkPolicy,
      serverId: appsTable.previewServerId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    enabled: r.enabled,
    baseDomain: r.baseDomain,
    maxActive:
      r.maxActive && r.maxActive > 0 ? r.maxActive : PREVIEW_MAX_ACTIVE_DEFAULT,
    ttlDays: r.ttlDays && r.ttlDays > 0 ? r.ttlDays : PREVIEW_TTL_DAYS_DEFAULT,
    forkPolicy: forkPolicyOf(r.forkPolicy),
    serverId: r.serverId,
  };
}

/** How many previews of this app are currently open (the cap's subject). */
async function countOpenPreviews(appId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(appPreviewsTable)
    .where(
      and(
        eq(appPreviewsTable.appId, appId),
        eq(appPreviewsTable.state, "open"),
        // The cap counts STACKS, not rows. A `blocked` fork has never been
        // cloned or built, and an `evicted` one had its stack removed — neither
        // is consuming the host, so neither may hold a slot hostage.
        notInArray(appPreviewsTable.status, ["blocked", "evicted"]),
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Make room for one more preview by tearing down the least recently active ones
 * until the app is back under `keep`. Returns how many were evicted.
 *
 * "Keep at most N" is meant literally, so the cap EVICTS rather than refusing —
 * but it evicts by `last_activity_at`, never by pull request age: the pull
 * request everyone is reviewing is usually the oldest one open, and killing it
 * to make room for a drive-by typo fix is precisely backwards.
 *
 * The row survives at `status = 'evicted'` with `state` still `open`. It keeps
 * its deploy key and host, so a later Redeploy revives the SAME URL. Nothing
 * revives it automatically — see {@link openOrSyncPreview}, where a webhook push
 * onto an evicted row deliberately refuses. Without that asymmetry, N active
 * pull requests under a cap of N would evict each other on every commit, a full
 * build burned per cycle.
 */
async function evictToFit(appId: string, keep: number): Promise<number> {
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
        notInArray(appPreviewsTable.status, ["blocked", "evicted"]),
      ),
    )
    .orderBy(asc(appPreviewsTable.lastActivityAt))
    .limit(Math.max(0, (await countOpenPreviews(appId)) - keep + 1));

  for (const v of victims) {
    // Stamp FIRST, then tear down: if the host is unreachable the row still reads
    // `evicted` (it is not serving anything the cap should count) and
    // `torn_down_at` stays NULL, which is exactly the reaper's retry predicate.
    await getDb()
      .update(appPreviewsTable)
      .set({ status: "evicted", updatedAt: nowIso() })
      .where(eq(appPreviewsTable.id, v.id));
    await teardownPreviewStack(v);
  }
  if (victims.length > 0) publishAppChanged(appId);
  return victims.length;
}

/** One app's preview row for a pull request number, or null. */
async function loadPreviewRow(
  appId: string,
  prNumber: number,
): Promise<typeof appPreviewsTable.$inferSelect | null> {
  const rows = await getDb()
    .select()
    .from(appPreviewsTable)
    .where(
      and(
        eq(appPreviewsTable.appId, appId),
        eq(appPreviewsTable.prNumber, prNumber),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Previews the reaper should act on, in two disjoint sets:
 *  - `retry`  — closed but never verifiably torn down (the agent was down).
 *  - `expired` — open, and idle for longer than the app's TTL.
 *
 * Both are plain state queries, which is why this scheduler needs no catch-up
 * window: a tick that never ran simply leaves the rows to the next one.
 */
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
        eq(appPreviewsTable.state, "closed"),
        isNull(appPreviewsTable.tornDownAt),
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

/**
 * Open previews whose pull request should be re-checked against GitHub — the
 * missed-`closed`-webhook safety net. Ordered oldest-checked first so one batch
 * per tick eventually covers everything.
 */
export async function openPreviewsForStateCheck(
  limit: number,
): Promise<
  { id: string; appId: string; prNumber: number; installationId: string | null; repo: string | null }[]
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
