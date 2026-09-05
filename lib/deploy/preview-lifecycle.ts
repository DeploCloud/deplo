import "server-only";

// https://deplo.build/docs/guides/networking/pull-request-previews

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { recordActivity } from "../data/activity";
import { loadAppGraph } from "../data/app-graph-load";
import { teardownApp } from "../data/deployments";
import { withKeyedLock } from "../data/keyed-mutex";
import { getServerById } from "../data/servers";
import { teardownOrQueue } from "../data/teardown-queue";
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
import { syncPreviewComment } from "./preview-comment";
import { previewHost, rehostNip, resolveServerIp } from "./domains";
import { mapLimit } from "../utils";

/**
 * The lifecycle of a **pull request preview** - open, sync, close, tear down.
 */

/** How many previews one app may have open at once when it sets no limit. */
export const PREVIEW_MAX_ACTIVE_DEFAULT = 3;

/** Idle days before the reaper closes a preview, when the app sets no limit. */
export const PREVIEW_TTL_DAYS_DEFAULT = 3;

/** How Deplo treats a pull request opened from a fork. */
export type PreviewForkPolicy = "deny" | "approve" | "allow";

/** NULL in the column ⇒ the safe middle: visible, but never built unasked. */
export function forkPolicyOf(
  value: string | null | undefined,
): PreviewForkPolicy {
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
  /** The fork's own clone URL - a fork's head ref does not exist on the base. */
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
 * Open (or refresh) the preview for one pull request and start its build. The URL
 * has already been commented on the pull request, so regenerating it on every push
 * would strand the link somebody is testing.
 */
export async function openOrSyncPreview(
  appId: string,
  pr: PullRequestFacts,
  opts: {
    actor: string;
    /** The git host `actor` is a login on, when a webhook opened this. */
    actorProvider?: string | null;
    /** A manual deploy approves a fork implicitly. */
    approve?: boolean;
    /**
     * A person asked for this build, rather than a webhook delivering a push.
     * The only thing it changes: a manual deploy REVIVES an evicted preview
     * (that is what the Redeploy button is for), a webhook never does.
     */
    manual?: boolean;
    /**
     * `false` ⇒ record the pull request's new facts and build nothing: a push on
     * a manual-only app, a title edit. Never creates a row and never reopens one.
     */
    build?: boolean;
  } = { actor: "github" },
): Promise<OpenOrSyncResult> {
  const syncOnly = opts.build === false;
  return withKeyedLock(`preview:${appId}:${pr.number}`, async () => {
    const app = await loadAppGraph(appId);
    if (!app) return { previewId: null, deploymentId: null };
    const settings = await previewSettings(appId);
    if (!settings) return { previewId: null, deploymentId: null };
    if (!settings.enabled) {
      return {
        previewId: null,
        deploymentId: null,
        refusal: { kind: "previews-off" },
      };
    }
    if (app.source !== "github" || !app.repo) {
      return {
        previewId: null,
        deploymentId: null,
        refusal: { kind: "not-github" },
      };
    }

    const existing = await loadPreviewRow(appId, pr.number);
    if (syncOnly && !existing) return { previewId: null, deploymentId: null };
    const policy = forkPolicyOf(settings.forkPolicy);
    // A fork's code is attacker-authored and would run on the operator's host.
    // `deny` never records it at all; `approve` records it so the pull request is
    // VISIBLE in the list with an approve button, but builds nothing.
    if (pr.isFork && policy === "deny" && !opts.approve) {
      return {
        previewId: null,
        deploymentId: null,
        refusal: { kind: "fork-denied" },
      };
    }
    // Per COMMIT, not per pull request.
    const approved =
      !pr.isFork ||
      policy === "allow" ||
      opts.approve ||
      (Boolean(existing?.approvedSha) && existing?.approvedSha === pr.headSha);

    const now = nowIso();
    let previewId = existing?.id ?? null;
    // An evicted preview keeps taking pull request updates - its title, head SHA and
    // state stay honest in the list, but a push does NOT rebuild it.
    const evictedAndUnasked = existing?.status === "evicted" && !opts.manual;
    const willBuild = approved && !evictedAndUnasked && !syncOnly;
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
          // host included, so the old link starts working again. A facts-only
          // sync reopens nothing: a title edit can arrive for a closed one.
          ...(syncOnly ? {} : { state: "open", closedAt: null }),
          // `torn_down_at` is the proof a stack is gone; only a build about to
          // start may erase it. Erasing it on an evicted preview's push made the
          // reaper retry a teardown of nothing, every hour, forever.
          ...(willBuild ? { tornDownAt: null } : {}),
          // Re-stamped whenever a NEW head is approved, not only the first time:
          // with a per-commit rule a stale `approved_sha` would refuse the very
          // build the caller just approved, and then refuse every one after it.
          ...(approved
            ? existing.approvedSha === pr.headSha
              ? {}
              : { approvedAt: now, approvedSha: pr.headSha }
            : { status: "blocked" }),
          lastActivityAt: now,
          updatedAt: now,
        })
        .where(eq(appPreviewsTable.id, existing.id));
      // An unreviewed commit on a fork whose reviewed commit is still RUNNING: the
      // stack serves code the pull request no longer contains, and a `blocked` row
      // holds no slot, so leaving it up would also put the app over its own limit.
      if (!approved && hasStack(existing)) {
        await stopPreview(existing, "blocked");
      }
    } else {
      // At the cap, the NEW preview wins and the least recently active one is torn
      // down - settled below, under the per-app lock, once the row exists.
      const server =
        (await getServerById(settings.serverId ?? app.serverId)) ?? undefined;
      const { host, certProvider } = previewHost({
        appId,
        slug: app.slug,
        prNumber: pr.number,
        baseDomain: settings.baseDomain,
        https: settings.https,
        ip: resolveServerIp(server),
      });
      previewId = newId("prv");
      await getDb()
        .insert(appPreviewsTable)
        .values({
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
          // Frozen here, like the host and the deploy key: the renderer reads the
          // preview ROW, and changing the app's setting must not silently repoint
          // a preview somebody is already testing.
          port: settings.port,
          status: approved ? "queued" : "blocked",
          state: "open",
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        });
    }

    // The cap has to be settled PER APP, not per pull request: the lock this function
    // runs under is keyed `appId:prNumber`, so two PRs opened together took DIFFERENT
    // locks, both read the same under-cap count above, neither evicted, and both took a
    if (willBuild)
      await withKeyedLock(`preview-cap:${appId}`, () =>
        // `+ 1` because evictToFit makes room FOR a preview about to be inserted (it evicts
        // `count - keep + 1`).
        evictToFit(appId, settings.maxActive + 1, settings.maxActive),
      );

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
    if (syncOnly) return { previewId, deploymentId: null };
    const deploymentId = await deployPreviewRow(previewId!, {
      actor: opts.actor,
      actorProvider: opts.actorProvider,
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
  opts: {
    actor: string;
    actorProvider?: string | null;
    commitMessage?: string;
  },
): Promise<string | null> {
  const row = await getDb()
    .select()
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  const p = row[0];
  if (!p) return null;
  const settings = await previewSettings(p.appId);
  const max = settings?.maxActive ?? PREVIEW_MAX_ACTIVE_DEFAULT;
  // The whole claim-and-queue under the per-app lock, the same one eviction takes:
  // fifteen pull requests opened together each inserted a row, a sibling's
  // eviction hit it in between, and `startDeployment` then wrote `queued` over
  // `evicted` - twelve stacks under a cap of five.
  return withKeyedLock(`preview-cap:${p.appId}`, async () => {
    const fresh = (
      await getDb()
        .select({
          status: appPreviewsTable.status,
          state: appPreviewsTable.state,
        })
        .from(appPreviewsTable)
        .where(eq(appPreviewsTable.id, previewId))
        .limit(1)
    )[0];
    // Closed while it waited for the lock: nothing to build.
    if (!fresh || fresh.state !== "open") return null;
    // A preview that holds no slot is about to start holding one, so it claims its
    // place exactly like a new preview would, otherwise reviving an evicted one, or
    // approving a fork that has been sitting blocked, would silently put the app over
    if ((SLOTLESS as readonly string[]).includes(fresh.status)) {
      if ((await countOpenPreviews(p.appId)) >= max)
        await evictToFit(p.appId, max, max);
      await getDb()
        .update(appPreviewsTable)
        .set({ status: "queued", tornDownAt: null, updatedAt: nowIso() })
        .where(eq(appPreviewsTable.id, previewId));
    }
    return startPreviewDeployment(p, opts);
  });
}

async function startPreviewDeployment(
  p: typeof appPreviewsTable.$inferSelect,
  opts: {
    actor: string;
    actorProvider?: string | null;
    commitMessage?: string;
  },
): Promise<string> {
  const previewId = p.id;
  try {
    return await startDeployment(p.appId, {
      environment: "preview",
      creator: opts.actor,
      creatorProvider: opts.actorProvider,
      commitMessage:
        opts.commitMessage || p.prTitle || `Pull request #${p.prNumber}`,
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
  } catch (e) {
    // A refusal before the row was even queued (a revoked host grant, a migration
    // still running) must not leave the list saying "queued" with nothing behind it.
    await getDb()
      .update(appPreviewsTable)
      .set({ status: "error", updatedAt: nowIso() })
      .where(
        and(
          eq(appPreviewsTable.id, previewId),
          eq(appPreviewsTable.status, "queued"),
        ),
      );
    publishAppChanged(p.appId);
    throw e;
  }
}

/**
 * Close a preview: stop accepting builds for it, cancel anything still queued, and
 * tear the stack down.
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
  await cancelQueuedPreviewDeploys(previewId);
  const gone = await teardownPreviewStack(p);
  publishAppChanged(p.appId);
  // Every way a preview closes tells the pull request, not only the webhook's:
  // the reaper's idle timeout and the Destroy button left a "Ready" link that 404s.
  void syncPreviewComment(previewId, { kind: "destroyed" });
  const app = await loadAppGraph(p.appId);
  await recordActivity(
    "deployment",
    gone
      ? `Destroyed the preview for pull request #${p.prNumber}${app ? ` of ${app.name}` : ""} (${reason})`
      : `Could not reach the server to destroy the preview for pull request #${p.prNumber}` +
          `${app ? ` of ${app.name}` : ""} - Deplo will retry`,
    "system",
    p.appId,
  );
  return gone;
}

/**
 * Destroy a preview's stack on its host and stamp `torn_down_at` on success. A
 * preview's volumes were created by, and only by, that preview; nobody asked to
 * keep their contents and nothing would ever point at them again.
 */
export async function teardownPreviewStack(p: {
  id: string;
  deployKey: string;
  tornDownAt: string | null;
}): Promise<boolean> {
  if (p.tornDownAt) return true;
  // Never built ⇒ nothing on any host. Asking the agent to `down -v` a stack with
  // no file reports a failure, and the reaper would repeat it every hour.
  const built = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.previewId, p.id),
        notInArray(deploymentsTable.status, ["queued", "canceled"]),
      ),
    )
    .limit(1);
  const ok =
    built.length === 0 ||
    (await teardownApp(p.deployKey, { removeVolumes: true }));
  if (ok) {
    await getDb()
      .update(appPreviewsTable)
      .set({ tornDownAt: nowIso(), updatedAt: nowIso() })
      .where(eq(appPreviewsTable.id, p.id));
  }
  return ok;
}

/** Nothing queued for a preview that is going down should ever start building. */
async function cancelQueuedPreviewDeploys(previewId: string): Promise<void> {
  await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled" })
    .where(
      and(
        eq(deploymentsTable.previewId, previewId),
        eq(deploymentsTable.status, "queued"),
      ),
    );
}

/** A preview whose containers may still be on a host: built at least once, and
 *  never confirmed gone. */
function hasStack(p: {
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

/**
 * Take a preview's stack down while its pull request stays open: the row keeps
 * its key and host at `status`, so Redeploy (or an approval) brings the same URL
 * back. Stamped FIRST, then torn down: if the host is unreachable the row already
 * holds no slot and `torn_down_at` stays NULL, which is what the reaper retries on.
 */
async function stopPreview(
  p: { id: string; deployKey: string; tornDownAt: string | null },
  status: "evicted" | "blocked",
): Promise<boolean> {
  await getDb()
    .update(appPreviewsTable)
    .set({ status, updatedAt: nowIso() })
    .where(eq(appPreviewsTable.id, p.id));
  await cancelQueuedPreviewDeploys(p.id);
  return teardownPreviewStack(p);
}

/**
 * Stop every running preview of an app because the machine they run on is about
 * to change (the app moves, or its preview server is repointed). Their stacks
 * live on the OLD host, and every lifecycle verb resolves the host from the app
 * row - so once that row changes, nothing could ever name them again. Runs
 * BEFORE the row is written, for exactly that reason.
 */
export async function stopPreviewsForServerChange(
  appId: string,
  /** The server previews will run on from now on. */
  newServerId: string,
): Promise<number> {
  const rows = await getDb()
    .select({
      id: appPreviewsTable.id,
      deployKey: appPreviewsTable.deployKey,
      tornDownAt: appPreviewsTable.tornDownAt,
      status: appPreviewsTable.status,
      latestDeploymentId: appPreviewsTable.latestDeploymentId,
      host: appPreviewsTable.host,
      url: appPreviewsTable.url,
    })
    .from(appPreviewsTable)
    .where(
      and(
        eq(appPreviewsTable.appId, appId),
        eq(appPreviewsTable.state, "open"),
      ),
    );
  const victims = rows.filter(hasStack);
  const settings = await previewSettings(appId);
  for (const v of victims) {
    await stopPreview(v, "evicted");
    void syncPreviewComment(v.id, {
      kind: "evicted",
      max: settings?.maxActive ?? PREVIEW_MAX_ACTIVE_DEFAULT,
    });
  }
  // A nip.io host carries the server's IP in its last label, so a preview minted
  // on the old machine would keep resolving THERE after Redeploy built it here.
  // Same re-host an app's own auto domains get on a move; a base-domain host is
  // the operator's DNS and stays.
  const newIp = resolveServerIp(
    (await getServerById(newServerId)) ?? undefined,
  );
  for (const r of rows) {
    const host = rehostNip(r.host, newIp);
    if (host === r.host) continue;
    await getDb()
      .update(appPreviewsTable)
      .set({
        host,
        url: r.url ? r.url.replace(r.host, host) : r.url,
        updatedAt: nowIso(),
      })
      .where(eq(appPreviewsTable.id, r.id));
  }
  if (victims.length > 0) publishAppChanged(appId);
  return victims.length;
}

/**
 * Tear down every preview stack of an app, for the paths that delete the app
 * itself. MUST run before the app row goes: the FK cascade drops the preview rows,
 * and with them the only record that those containers and volumes exist.
 */
export async function destroyPreviewsForApp(appId: string): Promise<void> {
  const rows = await getDb()
    .select({
      id: appPreviewsTable.id,
      deployKey: appPreviewsTable.deployKey,
      prNumber: appPreviewsTable.prNumber,
      appName: appsTable.name,
      teamId: appsTable.teamId,
      // Previews may be pinned to their own machine (`preview_server_id`), which
      // is where `startDeployment` sent this stack.
      serverId: sql<string>`coalesce(${appsTable.previewServerId}, ${appsTable.serverId})`,
    })
    .from(appPreviewsTable)
    .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
    .where(
      and(
        eq(appPreviewsTable.appId, appId),
        isNull(appPreviewsTable.tornDownAt),
      ),
    );
  // The queue, not `teardownPreviewStack`: these rows are about to CASCADE away with
  // the app, so the stamp they retry on is gone in a moment and nothing would ever
  // name these containers again. The comment goes first, and is awaited: the row
  // it reads is what the cascade is about to drop.
  await mapLimit(rows, 4, async (r) => {
    await syncPreviewComment(r.id, { kind: "destroyed" });
    await teardownOrQueue({
      serverId: r.serverId,
      deployKey: r.deployKey,
      projectLabel: r.id,
      label: `the preview for pull request #${r.prNumber} of ${r.appName}`,
      teamId: r.teamId,
    }).catch(() => false);
  });
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
  /** HTTPS on preview hosts. Forced OFF without a base domain - see below. */
  https: boolean;
  /** Rebuild when the pull request receives a new commit. */
  autoDeploy: boolean;
  /** Container port. NULL ⇒ the app's build port. */
  port: number | null;
  /** Build a pull request while it is still a draft. */
  buildDrafts: boolean;
  /** Post and keep updating the sticky comment on the pull request. */
  comment: boolean;
  /** A pull request must carry ONE of these to get a preview. Empty ⇒ no filter. */
  requiredLabels: string[];
} | null> {
  const rows = await getDb()
    .select({
      enabled: appsTable.previewEnabled,
      baseDomain: appsTable.previewBaseDomain,
      maxActive: appsTable.previewMaxActive,
      ttlDays: appsTable.previewTtlDays,
      forkPolicy: appsTable.previewForkPolicy,
      serverId: appsTable.previewServerId,
      https: appsTable.previewHttps,
      autoDeploy: appsTable.previewAutoDeploy,
      port: appsTable.previewPort,
      buildDrafts: appsTable.previewBuildDrafts,
      comment: appsTable.previewComment,
      requiredLabels: appsTable.previewRequiredLabels,
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
    // Coerced, not merely read: a nip.io host cannot hold a certificate, so without a
    // base domain the answer is no whatever the column says.
    https: Boolean(r.https) && Boolean(r.baseDomain?.trim()),
    autoDeploy: r.autoDeploy,
    port: r.port && r.port > 0 ? r.port : null,
    buildDrafts: r.buildDrafts,
    comment: r.comment,
    requiredLabels: parseRequiredLabels(r.requiredLabels),
  };
}

/**
 * Split the stored newline list into the labels a pull request may match. Matching
 * is case-insensitive because GitHub labels are, and lower-casing here means the
 * comparison site never has to remember.
 */
export function parseRequiredLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split("\n")
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/**
 * The statuses that hold NO slot against the cap, because neither has a stack:
 * `blocked` was never cloned or built, `evicted` had its stack removed.
 */
const SLOTLESS = ["blocked", "evicted"] as const;

/** How many previews of this app are currently open (the cap's subject). */
async function countOpenPreviews(appId: string): Promise<number> {
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

/**
 * Make room for one more preview by tearing down the least recently active ones
 * until the app is back under `keep`. `max` is the limit the pull request is told.
 */
async function evictToFit(
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
 * Previews the reaper should act on, in two disjoint sets: `retry` - stopped
 * (closed, evicted, or a fork sent back to `blocked`) but never verifiably torn
 * down, because the agent was down; `expired` - open, and idle past the app's TTL.
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

/**
 * Finish a teardown the reaper picked up, unless the row moved on since it was
 * picked: a Redeploy or an approval in between made it `queued`, and its stack is
 * now the one being built, not the one that was left behind.
 */
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

/** How long a closed pull request keeps its row in the list. */
export const PREVIEW_CLOSED_RETENTION_DAYS = 7;

/**
 * Drop the rows of pull requests closed long enough ago, once their stack is
 * confirmed gone. A row is the only proof a stack exists, so one whose teardown
 * never succeeded is kept whatever its age; a deployment keeps its own copy of
 * the pull request URL, so history loses nothing.
 */
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

/**
 * Open previews whose pull request should be re-checked against GitHub - the
 * missed-`closed`-webhook safety net. Ordered oldest-checked first so one batch
 * per tick eventually covers everything.
 */
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
