import "server-only";

import { cache } from "react";
import { and, asc, eq } from "drizzle-orm";

import { getCurrentUser } from "../auth";
import { encryptSecret } from "../crypto";
import { getDb } from "../db/client";
import {
  apps as appsTable,
  appPreviews as appPreviewsTable,
  appPreviewEnvVars as appPreviewEnvVarsTable,
  githubInstallation as githubInstallationTable,
} from "../db/schema/control-plane";
import {
  closePreview,
  deployPreviewRow,
  destroyPreviewsForApp,
  forkPolicyOf,
  openOrSyncPreview,
  parseRequiredLabels,
  previewSettings,
  refusalMessage,
  type PreviewForkPolicy,
} from "../deploy/preview-lifecycle";
import { isValidPreviewBaseDomain } from "../deploy/domains";
import { listOpenPullRequests, type GithubPullRequestSummary } from "../github/app";
import { githubFullName } from "../github/repo-id";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { loadAppGraph } from "./app-graph-load";
import { requireFolderCapabilityForApp } from "./folder-access";
import { assertPreviewBaseNotAnotherTeams } from "./domains";
import { listServersForTeam } from "./servers";
import { requireAppCapability } from "./node-access";

/**
 * The gated surface for **pull request previews** — the security boundary the
 * UI and GraphQL go through.
 *
 * The mechanics live one layer down in
 * [preview-lifecycle](../deploy/preview-lifecycle.ts), which is deliberately
 * session-free so the GitHub webhook and the reaper can call it with no request
 * identity. Everything here does the `requireCapability` + team + folder work
 * FIRST and only then delegates, exactly like the deploy mutations do.
 */

/** The runtime state of one preview, as the UI renders it. */
export type PreviewState =
  | "blocked"
  | "queued"
  | "building"
  | "active"
  | "error"
  | "idle"
  /** Stopped by the app's own limit, not by the pull request. Its stack is gone
   *  but the row keeps its key and host, so Redeploy revives the same URL. */
  | "evicted";

export interface AppPreviewDTO {
  id: string;
  appId: string;
  prNumber: number;
  title: string;
  author: string;
  pullRequestUrl: string;
  headBranch: string;
  baseBranch: string;
  headRepo: string;
  isFork: boolean;
  approved: boolean;
  /** The commit that was approved, when a fork preview was unblocked. */
  approvedSha: string | null;
  status: PreviewState;
  url: string;
  host: string;
  /** Closed pull requests keep their row until the reaper prunes it. */
  closed: boolean;
  latestDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Why the Pull requests page cannot show previews, if it cannot. Resolved
 * server-side into ONE value so the page is a switch rather than a pile of
 * client-side guesses — and so a user is never left wondering why nothing
 * builds.
 */
export type PreviewsUnavailable =
  | "not-github"
  | "no-installation"
  | "app-needs-update"
  | "disabled";

export interface AppPreviewsView {
  appId: string;
  /** null ⇒ previews work; otherwise the single reason they do not. */
  unavailable: PreviewsUnavailable | null;
  /** The branch pull requests must target to get a preview. */
  branch: string;
  /** Deep link to this GitHub App's permissions page, when one is knowable. */
  githubSettingsUrl: string | null;
  enabled: boolean;
  baseDomain: string | null;
  maxActive: number;
  ttlDays: number;
  forkPolicy: PreviewForkPolicy;
  /** Where previews run. null ⇒ the app's own server. */
  serverId: string | null;
  /** HTTPS on preview hosts. Always false without a base domain. */
  https: boolean;
  /** Rebuild when the pull request receives a new commit. */
  autoDeploy: boolean;
  /** Container port. null ⇒ the app's build port. */
  port: number | null;
  /** Build a pull request that is still a draft. */
  buildDrafts: boolean;
  /** Post and keep updating the sticky comment on the pull request. */
  comment: boolean;
  /** A pull request must carry ONE of these. Empty ⇒ no filter. */
  requiredLabels: string[];
  previews: AppPreviewDTO[];
}

function toDTO(r: typeof appPreviewsTable.$inferSelect): AppPreviewDTO {
  return {
    id: r.id,
    appId: r.appId,
    prNumber: r.prNumber,
    title: r.prTitle,
    author: r.prAuthor,
    pullRequestUrl: r.prUrl,
    headBranch: r.headBranch,
    baseBranch: r.baseBranch,
    headRepo: r.headRepo,
    isFork: r.isFork,
    // Approval is per COMMIT for a fork (see `approvePreview`), so "approved"
    // has to mean "this head was approved" and not "something once was" — a
    // stale true is a button the UI hides on the exact push that needs it.
    approved: r.isFork
      ? Boolean(r.approvedSha) && r.approvedSha === r.headSha
      : Boolean(r.approvedAt),
    approvedSha: r.approvedSha,
    status: (r.state === "closed" ? "idle" : r.status) as PreviewState,
    url: r.url,
    host: r.host,
    closed: r.state === "closed",
    latestDeploymentId: r.latestDeploymentId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The app, confirmed to belong to the active team. Throws like every other
 *  data-layer probe — an id from another team reads as "not found". */
async function ownedApp(appId: string) {
  const teamId = await requireActiveTeamId();
  const app = await loadAppGraph(appId);
  if (!app || app.teamId !== teamId) throw new Error("App not found");
  return app;
}

/**
 * Everything the Pull requests page renders, in one read: whether previews can
 * work at all, the branch they watch, the app's settings, and the previews
 * themselves (open first, then most recently touched).
 */
export const listAppPreviews = cache(
  async (appId: string): Promise<AppPreviewsView> => {
    // The team check alone is not a gate: an app can sit in a folder this member
    // cannot see, and a bare `ownedApp` would hand its pull requests, branch and
    // preview URLs straight over. `requireAppCapability` resolves team, folder
    // and per-node grants together (ADR-0016) and answers "App not found" to all
    // three, so it is never an oracle for which ids exist.
    await requireAppCapability(appId, "manage_previews");
    const app = await ownedApp(appId);
    const settings = (await previewSettings(appId))!;

    let unavailable: PreviewsUnavailable | null = null;
    let githubSettingsUrl: string | null = null;
    if (app.source !== "github" || !app.repo) {
      unavailable = "not-github";
    } else if (!app.repo.installationId) {
      unavailable = "no-installation";
    } else {
      // The App must be subscribed to `pull_request` deliveries. Nothing arrives
      // otherwise, and a user staring at an empty list deserves to know why.
      const ready = await githubAppPreviewReadiness(app.repo.installationId);
      githubSettingsUrl = ready.settingsUrl;
      if (!ready.ready) unavailable = "app-needs-update";
      else if (!settings.enabled) unavailable = "disabled";
    }
    if (!unavailable && !settings.enabled) unavailable = "disabled";

    const rows = await getDb()
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.appId, appId))
      .orderBy(asc(appPreviewsTable.state), asc(appPreviewsTable.prNumber));
    return {
      appId,
      unavailable,
      branch: app.repo?.branch || "main",
      githubSettingsUrl,
      enabled: settings.enabled,
      baseDomain: settings.baseDomain,
      maxActive: settings.maxActive,
      ttlDays: settings.ttlDays,
      forkPolicy: settings.forkPolicy,
      serverId: settings.serverId,
      https: settings.https,
      autoDeploy: settings.autoDeploy,
      port: settings.port,
      buildDrafts: settings.buildDrafts,
      comment: settings.comment,
      requiredLabels: settings.requiredLabels,
      previews: rows.map(toDTO),
    };
  },
);

/**
 * Whether the GitHub App behind an installation can actually drive previews.
 * Read live (never stored) because the operator fixes it on github.com, not
 * here, and a stale "needs update" badge would be worse than none. A GitHub
 * failure degrades to `ready: true` — better to show an empty list than to
 * accuse a correctly-configured App of being broken.
 */
async function githubAppPreviewReadiness(
  installationId: string,
): Promise<{ ready: boolean; settingsUrl: string | null }> {
  const rows = await getDb()
    .select({ appId: githubInstallationTable.appId })
    .from(githubInstallationTable)
    .where(eq(githubInstallationTable.id, installationId))
    .limit(1);
  const appDbId = rows[0]?.appId;
  if (!appDbId) return { ready: true, settingsUrl: null };
  const { readAppCapabilities } = await import("../github/app");
  const caps = await readAppCapabilities(appDbId);
  if (!caps) return { ready: true, settingsUrl: null };
  return { ready: caps.previewReady, settingsUrl: caps.settingsUrl };
}

/** The open pull requests of an app's repo, for the "Deploy a pull request"
 *  picker. `deploy`-gated: it spends a GitHub API call and only ever precedes a
 *  deploy. */
export async function listOpenPullRequestsForApp(
  appId: string,
): Promise<GithubPullRequestSummary[]> {
  await requireCapability("manage_previews");
  const app = await ownedApp(appId);
  await requireFolderCapabilityForApp(appId, "manage_previews");
  const full = app.repo ? githubFullName(app.repo) : null;
  if (!full || !app.repo?.installationId) return [];
  return listOpenPullRequests(app.repo.installationId, full);
}

/**
 * Build a preview for a specific open pull request, on purpose.
 *
 * This is what makes the feature useful the moment the switch goes on — before
 * the GitHub App is subscribed to `pull_request` events, and for the cases the
 * automatic path deliberately skips (a draft, a pull request into another
 * branch, one that was destroyed and is wanted back). Reading pull requests
 * needs only `pull_requests: read`, which every Deplo GitHub App has always had.
 *
 * A member with `deploy` clicking this on a FORK is exactly the approval the
 * fork guard asks for, so it approves in the same act.
 */
export async function deployPullRequest(
  appId: string,
  prNumber: number,
): Promise<AppPreviewDTO> {
  await requireCapability("manage_previews");
  const app = await ownedApp(appId);
  await requireFolderCapabilityForApp(appId, "manage_previews");
  const user = await getCurrentUser();
  const full = app.repo ? githubFullName(app.repo) : null;
  if (!full || !app.repo?.installationId) {
    throw new Error("Connect this app to a GitHub repository first");
  }
  const open = await listOpenPullRequests(app.repo.installationId, full);
  const pr = open.find((p) => p.number === prNumber);
  if (!pr) throw new Error(`Pull request #${prNumber} is not open on ${full}`);

  const res = await openOrSyncPreview(
    appId,
    {
      number: pr.number,
      title: pr.title,
      author: pr.authorLogin,
      url: pr.htmlUrl,
      headBranch: pr.headRef,
      headSha: pr.headSha,
      headRepo: pr.headRepo ?? "",
      headCloneUrl: pr.headCloneUrl ?? "",
      baseBranch: pr.baseRef,
      isFork: pr.fromFork,
    },
    { actor: user?.name ?? "Deplo", approve: true, manual: true },
  );
  if (res.refusal) throw new Error(refusalMessage(res.refusal));
  const dto = await previewById(res.previewId!);
  await recordActivity(
    "deployment",
    `Deployed a preview of ${app.name} for pull request #${prNumber}`,
    user?.name ?? "Deplo",
    appId,
  );
  return dto;
}

/** Rebuild an existing preview at its current head. */
export async function redeployPreview(previewId: string): Promise<AppPreviewDTO> {
  await requireCapability("manage_previews");
  const p = await ownedPreview(previewId);
  await requireFolderCapabilityForApp(p.appId, "manage_previews");
  // Per COMMIT for a fork: a preview approved three pushes ago is not an
  // approval of what Redeploy would build now. Same rule `openOrSyncPreview`
  // applies to a webhook, so the button and the push cannot disagree.
  if (p.isFork ? p.approvedSha !== p.headSha : !p.approvedAt) {
    throw new Error("Approve this fork pull request before building it");
  }
  const user = await getCurrentUser();
  await deployPreviewRow(previewId, { actor: user?.name ?? "Deplo" });
  return previewById(previewId);
}

/**
 * Unblock a fork's pull request and build it.
 *
 * Approval is per pull request, not per commit: a click for every push would be
 * unusable, and it is how GitHub's own "Approve and run" behaves. `approved_sha`
 * records WHAT was reviewed so the UI can show it. The independent second layer
 * is that a fork preview never receives `secret`-typed variables at all.
 */
export async function approvePreview(previewId: string): Promise<AppPreviewDTO> {
  const { userId } = await requireCapability("manage_previews");
  const p = await ownedPreview(previewId);
  await requireFolderCapabilityForApp(p.appId, "manage_previews");
  const user = await getCurrentUser();
  const now = nowIso();
  const updated = await getDb()
    .update(appPreviewsTable)
    .set({
      approvedByUserId: userId,
      approvedAt: now,
      approvedSha: p.headSha,
      // Deliberately NOT `status: "queued"`. Leaving the row `blocked` is what
      // lets `deployPreviewRow` see that it holds no slot and claim one — moving
      // it here would seat the fork without evicting anything and put the app
      // over its own limit. Approval records consent; the deploy owns the state.
      updatedAt: now,
    })
    .where(
      and(eq(appPreviewsTable.id, previewId), eq(appPreviewsTable.appId, p.appId)),
    )
    .returning({ id: appPreviewsTable.id });
  if (updated.length === 0) throw new Error("Preview not found");
  await recordActivity(
    "deployment",
    `Approved the fork pull request #${p.prNumber} preview (${p.headRepo || "fork"} at ${p.headSha.slice(0, 7)})`,
    user?.name ?? "Deplo",
    p.appId,
  );
  await deployPreviewRow(previewId, { actor: user?.name ?? "Deplo" });
  return previewById(previewId);
}

/** Destroy a preview's containers and volumes now. Reversible: the next push to
 *  the pull request builds it again (unless previews are switched off). */
export async function destroyPreview(previewId: string): Promise<boolean> {
  await requireCapability("manage_previews");
  const p = await ownedPreview(previewId);
  await requireFolderCapabilityForApp(p.appId, "manage_previews");
  return closePreview(previewId, "destroyed from Deplo");
}

/** Per-app preview settings. Everything but the switch is advanced. */
export interface AppPreviewSettingsInput {
  enabled?: boolean;
  /** `preview.example.com`; empty string clears it back to the nip.io default. */
  baseDomain?: string | null;
  maxActive?: number | null;
  ttlDays?: number | null;
  forkPolicy?: string | null;
  /** Empty/null ⇒ back to the app's own server. */
  serverId?: string | null;
  https?: boolean;
  autoDeploy?: boolean;
  /** Null/0 ⇒ back to the app's build port. */
  port?: number | null;
  buildDrafts?: boolean;
  comment?: boolean;
  /** Newline-separated. Empty ⇒ no filter. */
  requiredLabels?: string | null;
}

export async function setAppPreviewSettings(
  appId: string,
  input: AppPreviewSettingsInput,
): Promise<void> {
  const { membership } = await requireCapability("manage_previews");
  const app = await loadAppGraph(appId);
  if (!app || app.teamId !== membership.teamId) throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "manage_previews");
  const user = await getCurrentUser();

  const patch: Partial<typeof appsTable.$inferInsert> = { updatedAt: nowIso() };
  if (input.enabled !== undefined) patch.previewEnabled = input.enabled;
  if (input.baseDomain !== undefined) {
    const clean = (input.baseDomain ?? "").trim().replace(/^\.+|\.+$/g, "");
    if (clean && !isValidPreviewBaseDomain(clean)) {
      throw new Error(
        `"${clean}" is not a hostname. Use something like preview.example.com, and point a wildcard DNS record at this server.`,
      );
    }
    // A preview host never goes in the `domains` table, so the cross-team
    // hostname guard there does not see it - and every preview under this base
    // gets a Traefik router and an ACME order. Same rule, applied where this
    // writer lives.
    if (clean) await assertPreviewBaseNotAnotherTeams(clean, membership.teamId);
    patch.previewBaseDomain = clean || null;
  }
  if (input.maxActive !== undefined) {
    // A cap, not a quota — bounded generously, and never clamped silently.
    if (input.maxActive != null && (input.maxActive < 1 || input.maxActive > 50)) {
      throw new Error("Keep the preview limit between 1 and 50");
    }
    patch.previewMaxActive = input.maxActive ?? null;
  }
  if (input.ttlDays !== undefined) {
    if (input.ttlDays != null && (input.ttlDays < 1 || input.ttlDays > 365)) {
      throw new Error("Keep the idle limit between 1 and 365 days");
    }
    patch.previewTtlDays = input.ttlDays ?? null;
  }
  if (input.forkPolicy !== undefined) {
    patch.previewForkPolicy = input.forkPolicy
      ? forkPolicyOf(input.forkPolicy)
      : null;
  }
  if (input.serverId !== undefined) {
    const wanted = (input.serverId ?? "").trim();
    // Servers are cross-team-SHARED but still access-controlled (`all_teams` +
    // per-team grants), so the check is ACCESSIBILITY, not mere existence: a
    // member must not point previews at a server their team can't use (the
    // preview then deploys there unguarded). Same team-scoped picklist
    // `createApp` validates an explicit pick against.
    if (wanted) {
      const usable = await listServersForTeam(membership.teamId);
      if (!usable.some((s) => s.id === wanted))
        throw new Error("That server is not available to this team");
    }
    // The app's own server IS the default, so storing it explicitly would only
    // pin what is already true and survive a later app move.
    patch.previewServerId = wanted && wanted !== app.serverId ? wanted : null;
  }
  if (input.https !== undefined) patch.previewHttps = Boolean(input.https);
  if (input.autoDeploy !== undefined) {
    patch.previewAutoDeploy = Boolean(input.autoDeploy);
  }
  if (input.buildDrafts !== undefined) {
    patch.previewBuildDrafts = Boolean(input.buildDrafts);
  }
  if (input.comment !== undefined) patch.previewComment = Boolean(input.comment);
  if (input.port !== undefined) {
    if (input.port != null && input.port !== 0 && (input.port < 1 || input.port > 65535)) {
      throw new Error("Enter a port between 1 and 65535");
    }
    // 0 and null both mean "back to the app's build port" — a cleared number
    // input sends one or the other depending on the browser.
    patch.previewPort = input.port ? input.port : null;
  }
  if (input.requiredLabels !== undefined) {
    // Stored as the user typed it, minus the noise: the textarea is theirs, and
    // `parseRequiredLabels` is what normalises for matching. Re-joining the
    // parsed set here is what stops the field growing blank lines every save.
    const labels = parseRequiredLabels(input.requiredLabels);
    if (labels.length > 20) {
      throw new Error("Keep the label filter to 20 labels or fewer");
    }
    patch.previewRequiredLabels = labels.length ? labels.join("\n") : null;
  }

  const rows = await getDb()
    .update(appsTable)
    .set(patch)
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, membership.teamId)))
    .returning({ id: appsTable.id });
  if (rows.length === 0) throw new Error("App not found");
  // Turning previews OFF destroys the stacks that are up. The switch means "no
  // more pull request containers on my server", and it is the only reading that
  // leaves nothing behind: the Pull requests page disappears with it, so a
  // preview left running would be a container with no surface left to manage it
  // from. The confirm dialog says how many first.
  if (input.enabled === false) await destroyPreviewsForApp(appId);
  if (input.enabled !== undefined) {
    await recordActivity(
      "app",
      `${input.enabled ? "Enabled" : "Disabled"} pull request previews for ${app.name}`,
      user?.name ?? "Deplo",
      appId,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Preview-only variable overrides (advanced)                          */
/* ------------------------------------------------------------------ */

/** An override, masked exactly like every other stored secret: the ciphertext is
 *  never projected, and there is no reveal path. */
export interface PreviewEnvVarDTO {
  key: string;
  type: string;
  updatedAt: string;
}

export const listPreviewEnvVars = cache(
  async (appId: string): Promise<PreviewEnvVarDTO[]> => {
    await requireCapability("manage_env");
    await ownedApp(appId);
    await requireFolderCapabilityForApp(appId, "manage_env");
    const rows = await getDb()
      .select({
        key: appPreviewEnvVarsTable.key,
        type: appPreviewEnvVarsTable.type,
        updatedAt: appPreviewEnvVarsTable.updatedAt,
      })
      .from(appPreviewEnvVarsTable)
      .where(eq(appPreviewEnvVarsTable.appId, appId))
      .orderBy(asc(appPreviewEnvVarsTable.key));
    return rows;
  },
);

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function setPreviewEnvVar(
  appId: string,
  key: string,
  value: string,
  type: "plain" | "secret" = "plain",
): Promise<void> {
  const { userId } = await requireCapability("manage_env");
  const app = await ownedApp(appId);
  await requireFolderCapabilityForApp(appId, "manage_env");
  const clean = key.trim();
  if (!ENV_KEY_RE.test(clean)) {
    throw new Error(
      `"${clean}" is not a valid variable name — use letters, numbers and underscores, starting with a letter or underscore`,
    );
  }
  const user = await getCurrentUser();
  const now = nowIso();
  await getDb()
    .insert(appPreviewEnvVarsTable)
    .values({
      id: newId("penv"),
      appId,
      key: clean,
      valueEnc: encryptSecret(value),
      type,
      createdByUserId: userId,
      updatedByUserId: userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [appPreviewEnvVarsTable.appId, appPreviewEnvVarsTable.key],
      set: {
        valueEnc: encryptSecret(value),
        type,
        updatedByUserId: userId,
        updatedAt: now,
      },
    });
  await recordActivity(
    "app",
    `Set the preview override ${clean} on ${app.name}`,
    user?.name ?? "Deplo",
    appId,
  );
}

export async function deletePreviewEnvVar(
  appId: string,
  key: string,
): Promise<void> {
  await requireCapability("manage_env");
  const app = await ownedApp(appId);
  await requireFolderCapabilityForApp(appId, "manage_env");
  const user = await getCurrentUser();
  const rows = await getDb()
    .delete(appPreviewEnvVarsTable)
    .where(
      and(
        eq(appPreviewEnvVarsTable.appId, appId),
        eq(appPreviewEnvVarsTable.key, key),
      ),
    )
    .returning({ key: appPreviewEnvVarsTable.key });
  if (rows.length === 0) throw new Error("Variable not found");
  await recordActivity(
    "app",
    `Removed the preview override ${key} from ${app.name}`,
    user?.name ?? "Deplo",
    appId,
  );
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

/** A preview row, confirmed to hang off an app of the active team. */
async function ownedPreview(
  previewId: string,
): Promise<typeof appPreviewsTable.$inferSelect> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({ preview: appPreviewsTable })
    .from(appPreviewsTable)
    .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
    .where(and(eq(appPreviewsTable.id, previewId), eq(appsTable.teamId, teamId)))
    .limit(1);
  const row = rows[0]?.preview;
  if (!row) throw new Error("Preview not found");
  return row;
}

async function previewById(previewId: string): Promise<AppPreviewDTO> {
  const rows = await getDb()
    .select()
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  if (!rows[0]) throw new Error("Preview not found");
  return toDTO(rows[0]);
}
