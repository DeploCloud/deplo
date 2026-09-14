import "server-only";

// https://deplo.build/docs/guides/networking/pull-request-previews

import { cache } from "@/lib/request-cache";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { getCurrentUser } from "../auth/current-user";
import { encryptSecret } from "../crypto";
import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { appPreviews as appPreviewsTable } from "../db/schema/control-plane/deployments";
import { appPreviewEnvVars as appPreviewEnvVarsTable } from "../db/schema/control-plane/env-vars";
import { githubInstallation as githubInstallationTable } from "../db/schema/control-plane/integrations";
import {
  closePreview,
  destroyPreviewsForApp,
  stopPreviewsForServerChange,
} from "../deploy/preview-lifecycle/close";
import { deployPreviewRow } from "../deploy/preview-lifecycle/deploy";
import { refusalMessage } from "../deploy/preview-lifecycle/fork-guard";
import { openOrSyncPreview } from "../deploy/preview-lifecycle/open-sync";
import {
  forkPolicyOf,
  parseRequiredLabels,
  previewSettings,
  type PreviewForkPolicy,
} from "../deploy/preview-lifecycle/settings";
import { isValidPreviewBaseDomain } from "../deploy/domains";
import {
  listOpenPullRequests,
  type GithubPullRequestSummary,
} from "../github/app";
import { githubFullName } from "../github/repo-id";
import type { AccessRequirement } from "../git/provider-access";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { loadAppGraph } from "./app-graph-load";
import { requireFolderCapabilityForApp } from "./folder-access";
import { assertPreviewBaseNotAnotherTeams } from "./domains/hostname-claim";
import { canHostWorkloads, listServersForTeam } from "./servers/roster";
import { requireAppCapability } from "./node-access";
import { secretImmutable } from "../types/env";

// PreviewState - the runtime state of one preview, as the UI renders it.
export type PreviewState =
  "blocked" | "queued" | "building" | "active" | "error" | "idle" | "evicted";

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
  approvedSha: string | null;
  status: PreviewState;
  url: string;
  host: string;
  closed: boolean;
  latestDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

// PreviewsUnavailable - the ONE server-side reason the Pull requests page cannot show previews.
export type PreviewsUnavailable =
  "not-github" | "no-installation" | "app-needs-update" | "disabled";

export interface AppPreviewsView {
  appId: string;
  unavailable: PreviewsUnavailable | null;
  branch: string;
  githubSettingsUrl: string | null;
  githubMissingAccess: AccessRequirement[];
  enabled: boolean;
  baseDomain: string | null;
  maxActive: number;
  ttlDays: number;
  forkPolicy: PreviewForkPolicy;
  serverId: string | null;
  https: boolean;
  autoDeploy: boolean;
  port: number | null;
  buildDrafts: boolean;
  comment: boolean;
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
    // Per COMMIT for a fork: a stale true hides the button on the push that needs it.
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

// The app, confirmed to belong to the active team: another team's id reads as not found.
async function ownedApp(appId: string) {
  const teamId = await requireActiveTeamId();
  const app = await loadAppGraph(appId);
  if (!app || app.teamId !== teamId) throw new Error("App not found");
  return app;
}

// listAppPreviews - everything the Pull requests page renders, in one read.
export const listAppPreviews = cache(
  async (appId: string): Promise<AppPreviewsView> => {
    // The team check is not a gate: an app in a folder this member cannot see stays hidden.
    await requireAppCapability(appId, "manage_previews");
    const app = await ownedApp(appId);
    const settings = (await previewSettings(appId))!;

    let unavailable: PreviewsUnavailable | null = null;
    let githubSettingsUrl: string | null = null;
    let githubMissingAccess: AccessRequirement[] = [];
    if (app.source !== "github" || !app.repo) {
      unavailable = "not-github";
    } else if (!app.repo.installationId) {
      unavailable = "no-installation";
    } else {
      // The App must be subscribed to pull_request deliveries, or nothing ever arrives.
      const ready = await githubAppPreviewReadiness(app.repo.installationId);
      githubSettingsUrl = ready.settingsUrl;
      githubMissingAccess = ready.missing;
      if (!ready.ready) unavailable = "app-needs-update";
      else if (!settings.enabled) unavailable = "disabled";
    }
    if (!unavailable && !settings.enabled) unavailable = "disabled";

    // asc(state) would put "closed" ahead of "open", so the order is a case expression.
    const rows = await getDb()
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.appId, appId))
      .orderBy(
        asc(
          sql`case when ${appPreviewsTable.state} = 'open' then 0 else 1 end`,
        ),
        desc(appPreviewsTable.lastActivityAt),
      );
    return {
      appId,
      unavailable,
      branch: app.repo?.branch || "main",
      githubSettingsUrl,
      githubMissingAccess,
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

// Read live, never stored: the operator fixes this on github.com, and a stale badge is worse.
async function githubAppPreviewReadiness(installationId: string): Promise<{
  ready: boolean;
  settingsUrl: string | null;
  missing: AccessRequirement[];
}> {
  const unknown = { ready: true, settingsUrl: null, missing: [] };
  const rows = await getDb()
    .select({ appId: githubInstallationTable.appId })
    .from(githubInstallationTable)
    .where(eq(githubInstallationTable.id, installationId))
    .limit(1);
  const appDbId = rows[0]?.appId;
  if (!appDbId) return unknown;
  const { readAppAccess } = await import("../github/app");
  const access = await readAppAccess(appDbId);
  if (!access) return unknown;
  return {
    ready: access.previewReady,
    settingsUrl: access.settingsUrl,
    missing: [...access.missingCore, ...access.missingPreviews],
  };
}

// listOpenPullRequestsForApp - the repo's open pull requests for the picker; it spends a GitHub call.
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

// deployPullRequest - build a preview for one open pull request; on a FORK the click is the approval.
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

// redeployPreview - rebuild an existing preview at its current head.
export async function redeployPreview(
  previewId: string,
): Promise<AppPreviewDTO> {
  await requireCapability("manage_previews");
  const p = await ownedPreview(previewId);
  await requireFolderCapabilityForApp(p.appId, "manage_previews");
  // Per COMMIT for a fork: an approval three pushes ago is not an approval of this head.
  if (p.isFork ? p.approvedSha !== p.headSha : !p.approvedAt) {
    throw new Error("Approve this fork pull request before building it");
  }
  const user = await getCurrentUser();
  await deployPreviewRow(previewId, { actor: user?.name ?? "Deplo" });
  return previewById(previewId);
}

// approvePreview - unblock a fork's pull request and build it.
export async function approvePreview(
  previewId: string,
): Promise<AppPreviewDTO> {
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
      // Deliberately NOT "queued": blocked is what lets deployPreviewRow claim a slot.
      updatedAt: now,
    })
    .where(
      and(
        eq(appPreviewsTable.id, previewId),
        eq(appPreviewsTable.appId, p.appId),
      ),
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

// destroyPreview - destroy a preview's containers and volumes now; the next push builds it again.
export async function destroyPreview(previewId: string): Promise<boolean> {
  await requireCapability("manage_previews");
  const p = await ownedPreview(previewId);
  await requireFolderCapabilityForApp(p.appId, "manage_previews");
  return closePreview(previewId, "destroyed from Deplo");
}

// AppPreviewSettingsInput - per-app preview settings; everything but the switch is advanced.
export interface AppPreviewSettingsInput {
  enabled?: boolean;
  baseDomain?: string | null;
  maxActive?: number | null;
  ttlDays?: number | null;
  forkPolicy?: string | null;
  serverId?: string | null;
  https?: boolean;
  autoDeploy?: boolean;
  port?: number | null;
  buildDrafts?: boolean;
  comment?: boolean;
  requiredLabels?: string | null;
}

export async function setAppPreviewSettings(
  appId: string,
  input: AppPreviewSettingsInput,
): Promise<void> {
  const { membership } = await requireCapability("manage_previews");
  const app = await loadAppGraph(appId);
  if (!app || app.teamId !== membership.teamId)
    throw new Error("App not found");
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
    // A preview host never enters `domains`, so the cross-team guard there cannot see it.
    if (clean) await assertPreviewBaseNotAnotherTeams(clean, membership.teamId);
    patch.previewBaseDomain = clean || null;
  }
  if (input.maxActive !== undefined) {
    if (
      input.maxActive != null &&
      (input.maxActive < 1 || input.maxActive > 50)
    ) {
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
    // Servers are shared but access-controlled: the check is accessibility, not existence.
    if (wanted) {
      const usable = await listServersForTeam(membership.teamId);
      const picked = usable.find((s) => s.id === wanted);
      if (!picked) throw new Error("That server is not available to this team");
      // Accessible is not usable: a preview is a deploy, so a storage/build host is refused.
      if (!canHostWorkloads(picked))
        throw new Error(
          "Nothing is deployed on that server - pick one that runs apps",
        );
    }
    // The app's own server IS the default, so storing it would pin what is already true.
    patch.previewServerId = wanted && wanted !== app.serverId ? wanted : null;
    // Stopped while the column still names the OLD machine: every lifecycle verb reads it.
    const current = (await previewSettings(appId))?.serverId ?? app.serverId;
    const next = patch.previewServerId ?? app.serverId;
    if (next !== current) await stopPreviewsForServerChange(appId, next);
  }
  if (input.https !== undefined) patch.previewHttps = Boolean(input.https);
  if (input.autoDeploy !== undefined) {
    patch.previewAutoDeploy = Boolean(input.autoDeploy);
  }
  if (input.buildDrafts !== undefined) {
    patch.previewBuildDrafts = Boolean(input.buildDrafts);
  }
  if (input.comment !== undefined)
    patch.previewComment = Boolean(input.comment);
  if (input.port !== undefined) {
    if (
      input.port != null &&
      input.port !== 0 &&
      (input.port < 1 || input.port > 65535)
    ) {
      throw new Error("Enter a port between 1 and 65535");
    }
    // 0 and null both mean the app's build port - a cleared number input sends either.
    patch.previewPort = input.port ? input.port : null;
  }
  if (input.requiredLabels !== undefined) {
    // Re-joining the parsed set is what stops the field growing blank lines every save.
    const labels = parseRequiredLabels(input.requiredLabels);
    if (labels.length > 20) {
      throw new Error("Keep the label filter to 20 labels or fewer");
    }
    patch.previewRequiredLabels = labels.length ? labels.join("\n") : null;
  }

  const rows = await getDb()
    .update(appsTable)
    .set(patch)
    .where(
      and(eq(appsTable.id, appId), eq(appsTable.teamId, membership.teamId)),
    )
    .returning({ id: appsTable.id });
  if (rows.length === 0) throw new Error("App not found");
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

// PreviewEnvVarDTO - an override, masked like every stored secret: no ciphertext, no reveal path.
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
      `"${clean}" is not a valid variable name - use letters, numbers and underscores, starting with a letter or underscore`,
    );
  }
  // A secret override is frozen like every other secret.
  const stored = await getDb()
    .select({ type: appPreviewEnvVarsTable.type })
    .from(appPreviewEnvVarsTable)
    .where(
      and(
        eq(appPreviewEnvVarsTable.appId, appId),
        eq(appPreviewEnvVarsTable.key, clean),
      ),
    )
    .limit(1);
  if (stored[0]?.type === "secret") throw new Error(secretImmutable(clean));
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

// A preview row, confirmed to hang off an app of the active team.
async function ownedPreview(
  previewId: string,
): Promise<typeof appPreviewsTable.$inferSelect> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({ preview: appPreviewsTable })
    .from(appPreviewsTable)
    .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
    .where(
      and(eq(appPreviewsTable.id, previewId), eq(appsTable.teamId, teamId)),
    )
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
