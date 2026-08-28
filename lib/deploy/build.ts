import "server-only";

// https://deplo.build/docs/concepts/what-happens-on-a-deploy

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "../yaml";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getServerById } from "../data/servers";
import { copyImageBetween } from "../data/volume-migration";
import { resolveBuildServer, buildServerLogLine } from "./build-server";
import { getDb } from "../db/client";
import { withKeyedLock } from "../data/keyed-mutex";
import {
  deployments as deploymentsTable,
  apps as appsTable,
  appBuild as appBuildTable,
  appPreviews as appPreviewsTable,
  appPreviewEnvVars as appPreviewEnvVarsTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { decryptSecretOrThrow } from "../crypto";
import {
  resolveEnvEntries,
  type EnvEntryType,
  type PreviewOverrideEntry,
} from "./env-resolve";
import {
  loadAutoInjectedVarsForApp,
  loadSharedVarsForApp,
} from "../data/shared-vars";
import { recordActivity, resolveActorUserId } from "../data/activity";
import { dispatchAlert } from "../notify/dispatch";
import {
  loadDeployment,
  loadDomainsForApp,
  loadAppGraph,
  loadAppGraphBySlug,
  loadEnvVarsForApp,
} from "../data/app-graph-load";
import {
  appendLog,
  clearDeploymentLogs,
  finalizeDeploymentLogs,
} from "../data/deployment-logs";
import { deploymentToRow } from "../data/app-graph-rows";
import { extractArchive } from "./upload";
import {
  detectTreeFavicon,
  detectGithubFavicon,
  detectAppFilesFavicon,
  detectServedAppFavicon,
  appIconProbeTarget,
} from "../apps/favicon-detect";
import type { ServedIconTarget } from "../apps/favicon-agent";
import { isGithubRepo } from "../apps/favicon-shared";
import {
  detectRepoFramework,
  detectTreeFramework,
} from "../apps/framework-source";
import {
  supportsFrameworkDetection,
  type FrameworkId,
} from "../apps/framework-catalog";
import {
  appSlugFromDeployKey,
  deployImageRef,
  prNumberFromDeployKey,
  stackFilesDir,
  stackName,
} from "./deploy-key";
import { syncPreviewComment } from "./preview-comment";
import { planDeploySource, resolveBuildDir, type SourcePlan } from "./source";
import { normalizeBuildConfig } from "../frameworks";
import { usesComposeStack, hostVolumeName, formatBytes } from "../utils";
import { detectDefaultApp } from "./compose-stack";
import { certResolver, domainScheme } from "./domains";
import { completePendingAppMigration } from "../data/app-migration";
import { sweepSupersededAppImages } from "../data/docker-cleanup";
import { traefikRouterLabels } from "./routing";
import { renderResourceLimitsYaml } from "./resources";
import { renderHealthCheckYaml, renderYamlKeys } from "./health-check";
import { buildComposeStack } from "./compose-stack";
import { parseComposeUpArgs } from "./compose-args";
import {
  primaryDomainName,
  primaryDomainRow,
  routableRoutes,
  defaultRoute,
  pendingPrimaryRoute,
  type RoutableDomain,
} from "../data/domains";
import { basicAuthUsersValue } from "../data/basic-auth";
import { forkCloneUrl, resolveCloneUrl } from "../git/clone-url";
import { repoCloneRefusal } from "../git/repo-access";
import { publishAppChanged } from "../graphql/pubsub";
import {
  agentCapabilityForMethod,
  runAgentDeploy,
  AgentUnavailableError,
  type AgentBuildPlan,
} from "./agent-deploy";
import {
  connectAgent,
  agentPreflight,
  AgentUnreachableError,
  AgentVolumeCopyUnsupportedError,
} from "../infra/agent-client";
import { enqueueDeployment } from "./deploy-queue";
import { assertDataCopyIntact } from "../data/data-copy";
import { assertNotMigrating } from "../data/migration-guard";
import type {
  App,
  BuildMethod,
  CertProvider,
  Deployment,
  DeploymentEnvironment,
  EnvTarget,
  GitRepo,
  HealthCheck,
  LogLine,
  MountPropagation,
  ResourceLimits,
  VolumeMount,
} from "../types";
import { mountOptions, parseMountPropagation } from "../apps/volume-model";

/**
 * The owning server id for a DEPLOY KEY's app - its lifecycle verbs run on that
 * server's agent (every app is agent-backed now, the host running Deplo included).
 */
async function owningServerIdForDeployKey(
  deployKey: string,
): Promise<string | null> {
  const p = await loadAppGraphBySlug(appSlugFromDeployKey(deployKey));
  if (!p) return null;
  // A preview may be pinned to a machine of its own: `startDeployment` sends it to
  // `preview_server_id ?? server_id`, so every lifecycle verb has to read the same
  // column.
  let serverId = p.serverId;
  if (prNumberFromDeployKey(deployKey) !== null) {
    const rows = await getDb()
      .select({ previewServerId: appsTable.previewServerId })
      .from(appsTable)
      .where(eq(appsTable.id, p.id))
      .limit(1);
    serverId = rows[0]?.previewServerId ?? p.serverId;
  }
  // Servers stay JSONB-authoritative; confirm the owning server still exists.
  const server = await getServerById(serverId);
  return server ? server.id : null;
}

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const STACK_DIR = join(DATA_DIR, "stacks");

// Enqueue one build-log line. SYNCHRONOUS fire-and-forget into the buffered
// writer (PLAN §6 Decision 18) so it stays a `void` sink usable as a callback
// prop; the writer batches + flushes in the background.
function log(depId: string, level: LogLine["level"], text: string): void {
  appendLog(depId, { ts: nowIso(), level, text });
}

/**
 * Patch a deployment row.
 */
async function setDep(
  depId: string,
  patch: Partial<Deployment>,
  opts: { onlyIfNotCanceled?: boolean } = {},
): Promise<boolean> {
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.environment !== undefined) set.environment = patch.environment;
  if (patch.commitSha !== undefined) set.commitSha = patch.commitSha;
  if (patch.commitMessage !== undefined)
    set.commitMessage = patch.commitMessage;
  if (patch.commitAuthor !== undefined) set.commitAuthor = patch.commitAuthor;
  if (patch.branch !== undefined) set.branch = patch.branch;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
  if (patch.readyAt !== undefined) set.readyAt = patch.readyAt;
  if (patch.buildDurationMs !== undefined)
    set.buildDurationMs = patch.buildDurationMs;
  if (patch.imageRef !== undefined) set.imageRef = patch.imageRef;
  const rows = await getDb()
    .update(deploymentsTable)
    .set(set)
    .where(
      opts.onlyIfNotCanceled
        ? and(
            eq(deploymentsTable.id, depId),
            ne(deploymentsTable.status, "canceled"),
          )
        : eq(deploymentsTable.id, depId),
    )
    .returning({ appId: deploymentsTable.appId });
  // A deployment's status feeds the project's `latestDeployment` view, so push
  // the owning project to live subscribers when it changes.
  const appId = rows[0]?.appId;
  if (appId && "status" in patch) publishAppChanged(appId);
  return rows.length > 0;
}

/**
 * What a running deploy writes its LIVE state onto.
 */
type DeployTarget = {
  appId: string;
  /** Alert routing. The runner is detached and has no request identity, which is
   *  why the team rides along rather than being resolved at dispatch time. */
  teamId: string;
  name: string;
  slug: string;
} & (
  { kind: "app" } | { kind: "preview"; previewId: string; prNumber: number }
);

/**
 * The bits of a pull request preview a running deploy needs: the host it routes on
 * and the certificate provider that host was minted with.
 */
async function loadPreviewForDeploy(previewId: string): Promise<{
  id: string;
  host: string;
  certProvider: CertProvider;
  prNumber: number;
  isFork: boolean;
  headCloneUrl: string;
  /** Frozen at creation from the app's `preview_port`. NULL ⇒ the build port. */
  port: number | null;
} | null> {
  const rows = await getDb()
    .select({
      id: appPreviewsTable.id,
      host: appPreviewsTable.host,
      certProvider: appPreviewsTable.certProvider,
      prNumber: appPreviewsTable.prNumber,
      isFork: appPreviewsTable.isFork,
      headCloneUrl: appPreviewsTable.headCloneUrl,
      port: appPreviewsTable.port,
    })
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, certProvider: row.certProvider as CertProvider };
}

/** The target a deployment row belongs to. `preview_id` is the whole test. */
function targetFor(
  dep: Pick<Deployment, "appId" | "previewId" | "prNumber">,
  app: { teamId: string; name: string; slug: string },
): DeployTarget {
  const common = {
    appId: dep.appId,
    teamId: app.teamId,
    name: app.name,
    slug: app.slug,
  };
  return dep.previewId
    ? {
        ...common,
        kind: "preview",
        previewId: dep.previewId,
        prNumber: dep.prNumber ?? 0,
      }
    : { ...common, kind: "app" };
}

/**
 * Patch the deploy's owner. `status` is the only key both owners understand;
 * anything else (productionUrl, logo, framework) is App-only and its callers
 * already gate on production, so it simply never reaches the preview arm.
 */
async function setDeployState(
  target: DeployTarget,
  patch: Partial<typeof appsTable.$inferInsert>,
): Promise<void> {
  if (target.kind === "preview") {
    await getDb()
      .update(appPreviewsTable)
      .set({
        ...(patch.status === undefined ? {} : { status: patch.status }),
        lastActivityAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(eq(appPreviewsTable.id, target.previewId));
  } else {
    await getDb()
      .update(appsTable)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(appsTable.id, target.appId));
  }
  // Both owners hang off the app's live stream: the App header reads its own
  // status, the pull requests list re-reads its previews.
  publishAppChanged(target.appId);
}

/**
 * A user "Stop build" won: log it and settle the app to `idle` ("Stopped").
 */
async function markStopped(depId: string, target: DeployTarget): Promise<void> {
  log(
    depId,
    "warn",
    "Build stopped by user - result discarded. A build already running on the host may finish in the background; its output is not deployed.",
  );
  // Settle ONLY if this canceled deploy is still its owner's current one.
  const settled =
    target.kind === "preview"
      ? await getDb()
          .update(appPreviewsTable)
          .set({ status: "idle", updatedAt: nowIso() })
          .where(
            and(
              eq(appPreviewsTable.id, target.previewId),
              eq(appPreviewsTable.latestDeploymentId, depId),
            ),
          )
          .returning({ id: appPreviewsTable.id })
      : await getDb()
          .update(appsTable)
          .set({ status: "idle", updatedAt: nowIso() })
          .where(
            and(
              eq(appsTable.id, target.appId),
              eq(appsTable.latestDeploymentId, depId),
            ),
          )
          .returning({ id: appsTable.id });
  if (settled.length > 0) publishAppChanged(target.appId);
}

/**
 * Atomically write a deployment's terminal outcome UNLESS a "Stop build" already
 * claimed the row.
 */
async function commitOutcome(
  depId: string,
  target: DeployTarget,
  depPatch: Partial<Deployment>,
  appPatch: Partial<typeof appsTable.$inferInsert>,
  /** This deploy went BACKWARDS. Only the alert copy cares: everything else
   *  about settling a rollback is identical to settling any other deploy. */
  opts: { rollback?: boolean } = {},
): Promise<boolean> {
  if (!(await setDep(depId, depPatch, { onlyIfNotCanceled: true }))) {
    await markStopped(depId, target);
    // No alert: a cancel is somebody pressing "Stop build", and they know.
    return false;
  }
  await setDeployState(target, appPatch);
  // Every terminal outcome of every deploy funnels through here, so this one hook
  // covers success, build failure, an unreachable agent, an agent too old and a
  // thrown error, on both the single-image and the compose path, and, since previews
  // share the path, a pull request build too.
  const ok = depPatch.status === "ready";
  const what =
    target.kind === "preview"
      ? `${target.name} #${target.prNumber}`
      : target.name;
  dispatchAlert({
    teamId: target.teamId,
    key: ok ? "deployment_succeeded" : "deployment_failed",
    // A rollback is not "a new version": saying so to a channel would tell the
    // team something shipped forward at the exact moment somebody undid it.
    title: `${what} ${ok ? (opts.rollback ? "rolled back" : "deployed") : "failed to deploy"}`,
    body: ok
      ? opts.rollback
        ? "An earlier version is live again."
        : "The new version is live."
      : "The build log has the error that stopped it.",
    path:
      target.kind === "preview"
        ? `/apps/${target.slug}/pull-requests`
        : `/apps/${target.slug}`,
  });
  // Tell the pull request how its preview ended. Fire-and-forget by contract:
  // a GitHub failure must never fail a deploy that already succeeded.
  if (target.kind === "preview" && depPatch.status) {
    const kind =
      depPatch.status === "ready"
        ? ("ready" as const)
        : depPatch.status === "error"
          ? ("failed" as const)
          : null;
    if (kind) void syncPreviewComment(target.previewId, { kind });
  }
  return true;
}

/**
 * Deploy-time image retention: drop the superseded images beyond the policy's
 * keep-count on this deploy's server NOW, not at the next nightly sweep - a
 * fast-iterating app mints gigabytes of tagged-but-dead images between ticks (see
 * {@link sweepSupersededAppImages}).
 */
async function sweepAfterDeploy(
  depId: string,
  serverId: string,
): Promise<void> {
  const freed = await sweepSupersededAppImages(serverId);
  if (freed > 0) {
    log(
      depId,
      "info",
      `Reclaimed ${formatBytes(freed)} from superseded app images`,
    );
  }
}

/**
 * Read-only cancel check for the pre-build window (the queued→building claim
 * failed): if the row is already `canceled`, settle the app; otherwise no-op.
 * The terminal outcome sites use {@link commitOutcome} (an atomic CAS) instead.
 */
async function settleIfCanceled(
  depId: string,
  target: DeployTarget,
): Promise<boolean> {
  const rows = await getDb()
    .select({ status: deploymentsTable.status })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.id, depId))
    .limit(1);
  if (rows[0]?.status !== "canceled") return false;
  await markStopped(depId, target);
  return true;
}

/**
 * Whether this build reads the owning server's build cache, and the line the build
 * log opens with when it doesn't.
 */
export function noCacheForDeploy(build: {
  buildCache: boolean;
  buildCacheClearPending: boolean;
}): { noCache: boolean; reason: string } {
  if (build.buildCacheClearPending) {
    return {
      noCache: true,
      reason:
        "Build cache cleared - building from scratch, then caching again.",
    };
  }
  if (!build.buildCache) {
    return {
      noCache: true,
      reason: "Build cache is off for this app - building from scratch.",
    };
  }
  return { noCache: false, reason: "" };
}

/**
 * Spend the one-shot "Clear build cache". Called once a build has actually been
 * dispatched with it, so the NEXT deploy caches normally again. A no-op UPDATE
 * when nothing was armed.
 */
export async function consumeCacheClear(appId: string): Promise<void> {
  await getDb()
    .update(appBuildTable)
    .set({ buildCacheClearPending: false })
    .where(eq(appBuildTable.appId, appId));
}

/**
 * Set an auto-detected logo ONLY when the app has none yet - a conditional `WHERE
 * logo IS NULL` UPDATE.
 */
async function setLogoIfUnset(
  appId: string,
  logo: string | null,
): Promise<void> {
  if (!logo) return;
  const updated = await getDb()
    .update(appsTable)
    .set({ logo, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, appId), sql`${appsTable.logo} is null`))
    .returning({ id: appsTable.id });
  if (updated.length > 0) publishAppChanged(appId);
}

/**
 * Auto-detect a display logo from the source tree the deploy just extracted (an
 * upload build) and set it when the app has none yet. Best-effort, never fails or
 * delays the deploy.
 */
async function autoDetectLogoFromTree(
  appId: string,
  currentLogo: string | null,
  root: string,
  rootDirectory: string | null | undefined,
): Promise<void> {
  if (currentLogo) return; // already has a logo (template default / user's) - leave it
  try {
    await setLogoIfUnset(appId, await detectTreeFavicon(root, rootDirectory));
  } catch {
    /* detection is a cosmetic nicety; never let it disturb a deploy */
  }
}

/**
 * Auto-detect a display logo from a GitHub repo's own files via the API and set it
 * when the app has none yet. This is what makes a github/git app get an icon at
 * all, and covers apps created before the feature (they pick one up on redeploy).
 */
function autoDetectRepoLogo(
  appId: string,
  currentLogo: string | null,
  repo: Parameters<typeof detectGithubFavicon>[0],
  rootDirectory: string | null | undefined,
): void {
  if (currentLogo || !isGithubRepo(repo)) return;
  void detectGithubFavicon(repo, rootDirectory)
    .then((logo) => setLogoIfUnset(appId, logo))
    .catch(() => {});
}

/**
 * Store the framework recognised in an app's source. Clearing is spelled `is not
 * null` rather than `is distinct from <null>` - the same split `updateAppLogo`
 * makes, because an untyped NULL parameter is not something to hand Postgres.
 */
async function setFramework(
  appId: string,
  framework: FrameworkId | null,
): Promise<void> {
  const updated = await getDb()
    .update(appsTable)
    .set({ framework, updatedAt: nowIso() })
    .where(
      and(
        eq(appsTable.id, appId),
        framework === null
          ? sql`${appsTable.framework} is not null`
          : sql`${appsTable.framework} is distinct from ${framework}`,
      ),
    )
    .returning({ id: appsTable.id });
  if (updated.length > 0) publishAppChanged(appId);
}

/**
 * Whether THIS deploy can recognise a framework at all: only the auto-detecting
 * builders (Nixpacks / Railpack - the one gate, shared with the API and the UI)
 * and only for a source whose files Deplo can read (a repo, an uploaded archive).
 */
function canRecognizeFramework(app: {
  source: string;
  build: { buildMethod: BuildMethod };
}): boolean {
  if (!supportsFrameworkDetection(app.build.buildMethod)) return false;
  return app.source !== "docker-image" && app.source !== "compose";
}

/**
 * Recognise the framework in a GitHub repo and store it.
 */
function autoDetectRepoFramework(
  appId: string,
  repo: GitRepo,
  rootDirectory: string | null | undefined,
): void {
  void detectRepoFramework(repo, rootDirectory)
    .then((hints) => setFramework(appId, hints.framework))
    .catch(() => {});
}

/**
 * Recognise the framework in the tree this deploy just extracted (the upload arm)
 * and store it.
 */
async function autoDetectFrameworkFromTree(
  appId: string,
  root: string,
  rootDirectory: string | null | undefined,
): Promise<void> {
  try {
    await setFramework(appId, await detectTreeFramework(root, rootDirectory));
  } catch {
    /* recognition is a label; never let it disturb a deploy */
  }
}

/**
 * When to re-ask a freshly deployed app for its icon. `compose up` returns once
 * the containers are RUNNING, which is well before an app is SERVING: a database
 * migration, a first-boot setup, a JIT warm-up all sit between the two.
 */
const ICON_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

/**
 * Auto-detect a display logo for a COMPOSE STACK on its owning host: the app's own
 * files first, then, the case that covers most compose apps, the icon the
 * running app SERVES, since a stack of prebuilt images keeps its favicon inside
 * the image where no file walk can reach it.
 */
function autoDetectComposeLogo(
  appId: string,
  currentLogo: string | null,
  serverId: string,
  slug: string,
  target: ServedIconTarget | null,
): void {
  if (currentLogo) return;
  void (async () => {
    // The files dir is already final at this point, so one look is enough.
    const fromFiles = await detectAppFilesFavicon(serverId, slug).catch(
      () => null,
    );
    if (fromFiles) {
      await setLogoIfUnset(appId, fromFiles);
      return;
    }
    if (!target) return;
    for (let attempt = 0; ; attempt++) {
      const logo = await detectServedAppFavicon(serverId, target).catch(
        () => null,
      );
      if (logo) {
        await setLogoIfUnset(appId, logo);
        return;
      }
      if (attempt >= ICON_RETRY_DELAYS_MS.length) return;
      await new Promise((r) => setTimeout(r, ICON_RETRY_DELAYS_MS[attempt]));
    }
  })().catch(() => {
    /* detection is a cosmetic nicety; never let it disturb a deploy */
  });
}

/** What a pull request preview tells its own containers about themselves. */
interface PreviewEnvContext {
  host: string;
  url: string;
  branch: string;
  prNumber: number;
  isFork: boolean;
}

/**
 * The `DEPLO_*` variables a preview's containers get for free - enough for an app
 * to know it is a preview and to build absolute self-links (an OAuth callback, a
 * canonical URL) without the user configuring anything per pull request.
 */
function previewEnvExtras(ctx: PreviewEnvContext): Record<string, string> {
  return {
    DEPLO_ENVIRONMENT: "preview",
    DEPLO_PREVIEW: "1",
    DEPLO_PREVIEW_HOST: ctx.host,
    DEPLO_PREVIEW_URL: ctx.url,
    DEPLO_GIT_BRANCH: ctx.branch,
    DEPLO_PR_NUMBER: String(ctx.prNumber),
  };
}

/**
 * Decrypted env for the stack being deployed: the app's own vars targeting this
 * runtime, plus every shared var the app opted into (linked) that also targets it,
 * plus instance globals.
 */
async function appEnv(
  appId: string,
  target: EnvTarget = "production",
  opts: { preview?: PreviewEnvContext | null } = {},
): Promise<Record<string, string>> {
  const preview = opts.preview ?? null;
  const [vars, sharedVars, autoInjected, previewOverrides] = await Promise.all([
    loadEnvVarsForApp(appId),
    loadSharedVarsForApp(appId),
    loadAutoInjectedVarsForApp(appId),
    target === "preview" ? loadPreviewEnvOverrides(appId) : Promise.resolve([]),
  ]);
  const dropSecrets = Boolean(preview?.isFork);
  // `T extends { type: EnvEntryType }` rather than a cast: the cast is what let
  // two of the four layers arrive with no `type` at all and be kept as if they
  // were plain. Every loader below now has to carry it, and the compiler says so.
  const keep = <T extends { type: EnvEntryType }>(list: T[]): T[] =>
    dropSecrets ? list.filter((e) => e.type !== "secret") : list;
  const out: Record<string, string> = preview ? previewEnvExtras(preview) : {};
  for (const e of resolveEnvEntries(
    target,
    appId,
    keep(vars),
    keep(sharedVars),
    keep(autoInjected),
    keep(previewOverrides),
  )) {
    // STRICT at the deploy edge. Refusing to deploy is the only honest answer to a
    // secret we cannot read.
    out[e.key] = decryptSecretOrThrow(e.valueEnc, `The variable ${e.key}`);
  }
  return out;
}

/** The app's preview-only variable overrides, still encrypted. Store-direct. */
async function loadPreviewEnvOverrides(
  appId: string,
): Promise<PreviewOverrideEntry[]> {
  const rows = await getDb()
    .select({
      key: appPreviewEnvVarsTable.key,
      valueEnc: appPreviewEnvVarsTable.valueEnc,
      type: appPreviewEnvVarsTable.type,
    })
    .from(appPreviewEnvVarsTable)
    .where(eq(appPreviewEnvVarsTable.appId, appId))
    .orderBy(appPreviewEnvVarsTable.key);
  return rows.map((r) => ({
    key: r.key,
    valueEnc: r.valueEnc,
    type: r.type === "secret" ? ("secret" as const) : ("plain" as const),
  }));
}

/**
 * The NAMES of the env vars a production deploy resolves for a project - exactly
 * the keys `appEnv` would carry (same selection seam), but WITHOUT decrypting any
 * value.
 */
async function appEnvKeys(
  appId: string,
  target: EnvTarget = "production",
  opts: { preview?: PreviewEnvContext | null } = {},
): Promise<string[]> {
  const preview = opts.preview ?? null;
  const [vars, sharedVars, autoInjected, previewOverrides] = await Promise.all([
    loadEnvVarsForApp(appId),
    loadSharedVarsForApp(appId),
    loadAutoInjectedVarsForApp(appId),
    target === "preview" ? loadPreviewEnvOverrides(appId) : Promise.resolve([]),
  ]);
  const dropSecrets = Boolean(preview?.isFork);
  // `T extends { type: EnvEntryType }` rather than a cast: the cast is what let
  // two of the four layers arrive with no `type` at all and be kept as if they
  // were plain. Every loader below now has to carry it, and the compiler says so.
  const keep = <T extends { type: EnvEntryType }>(list: T[]): T[] =>
    dropSecrets ? list.filter((e) => e.type !== "secret") : list;
  // De-dupe on key (the resolver emits lowest-precedence first; a later entry
  // wins on value, but for NAMES we just need the distinct set). The `DEPLO_*`
  // preview context rides the same env-file, so its keys belong here too.
  const seen = new Set<string>(
    preview ? Object.keys(previewEnvExtras(preview)) : [],
  );
  for (const e of resolveEnvEntries(
    target,
    appId,
    keep(vars),
    keep(sharedVars),
    keep(autoInjected),
    keep(previewOverrides),
  )) {
    seen.add(e.key);
  }
  return [...seen];
}

// Exported for unit tests (render byte-identical contract + the volume YAML
// shape). Pure: no docker, store, or fs access.
export function renderCompose(opts: {
  name: string;
  image: string;
  port: number;
  appId: string;
  /**
   * The stack's DEPLOY KEY - what the files dir, the named volumes and the
   * `deplo.slug` label are named after.
   */
  deployKey: string;
  /**
   * What the `deplo.project` label carries - the value the telemetry stream
   * buckets container stats by.
   */
  trackingId?: string;
  /** Public hostnames + per-domain port overrides, primary first. */
  routes: RoutableDomain[];
  env: Record<string, string>;
  /**
   * User-managed volumes. Empty/absent (and no NAMED volumes) ⇒ NO `volumes:` keys
   * are emitted, keeping the output byte-identical to the long-standing stack so a
   * reroute of an unchanged routing set never restarts the container.
   */
  volumes?: {
    type?: "named" | "app" | "host";
    name: string;
    projectPath?: string;
    hostPath?: string;
    mountPath: string;
    readOnly?: boolean;
    /** Host binds only: follow submounts appearing later (`rslave`/`rshared`). */
    propagation?: MountPropagation;
  }[];
  /** The app's health check, or null/absent when it has none. */
  healthCheck?: HealthCheck | null;
  /** The `healthcheck:` map read back off the running stack. Wins over
   *  `healthCheck`, and is what a routing change passes so it changes nothing. */
  healthCheckKeys?: Record<string, unknown> | null;
  /**
   * Whether to inject `PORT=<port>` into the container env.
   */
  injectPort?: boolean;
  /**
   * App-wide HTTP Basic Auth htpasswd users (`user:$2b$…,user2:…`, raw
   * single-`$`).
   */
  basicAuthUsers?: string;
  /**
   * Per-app resource caps (RAM/CPU/PIDs/…).
   */
  resources?: ResourceLimits | null;
}): string {
  const { name, image, port, appId, deployKey, routes } = opts;
  const trackingId = opts.trackingId ?? appId;
  const injectPort = opts.injectPort ?? true;
  const vols = opts.volumes ?? [];
  const namedVols = vols.filter((v) => v.type !== "host" && v.type !== "app");
  // Absolute, per-project files dir - the same sandbox the `./<x>` compose
  // convention resolves to. A "service" mount's source is rendered here so it
  // stays isolated (never resolved against the stack dir by docker).
  const filesDir = stackFilesDir(deployKey);
  // Default PORT to the project's default container port so 12-factor apps
  // (buildpacks, Nixpacks, Railpack) bind where Traefik forwards.
  const env = injectPort
    ? { PORT: String(port), ...opts.env }
    : { ...opts.env };
  // Traefik routing (TLS via Let's Encrypt), one router per distinct target
  // port. The global web->websecure redirect is configured on the proxy, so no
  // per-router middleware is needed here.
  const labels = [
    // Single-image production flavour: per-port grouping under the bare baseKey, the
    // explicit `.service` label only when there's more than one router, and no
    // `traefik.docker.network` label (the stack joins only `deplo`).
    ...traefikRouterLabels({
      baseKey: name,
      routes,
      defaultPort: port,
      certResolver: certResolver(),
      ...(opts.basicAuthUsers
        ? {
            basicAuth: {
              name: `${name}-basicauth`,
              users: opts.basicAuthUsers,
            },
          }
        : {}),
    }),
    "deplo.managed=true",
    `deplo.project=${trackingId}`,
    `deplo.slug=${deployKey}`,
    // Only emitted when the tracking id is NOT the app id (a pull request
    // preview). Adding it unconditionally would change every production stack's
    // labels and break the byte-identical-reroute contract.
    ...(trackingId === appId ? [] : [`deplo.app=${appId}`]),
  ];
  // Each label is emitted as a JSON-encoded (⇒ valid YAML) double-quoted scalar
  // rather than a raw `"${l}"`.
  const labelsYaml = labels
    .map((l) => `      - ${JSON.stringify(l)}`)
    .join("\n");
  const envYaml = Object.keys(env).length
    ? "    environment:\n" +
      Object.entries(env)
        .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
        .join("\n") +
      "\n"
    : "";
  // Two volume fragments, each exactly "" when there are no volumes so the generated
  // stack stays byte-identical to the no-volumes baseline (the reroute contract).
  const appVolsYaml = vols.length
    ? "    volumes:\n" +
      vols
        .map((v) => {
          const source =
            v.type === "host"
              ? v.hostPath
              : v.type === "app"
                ? `${filesDir}/${v.projectPath}`
                : v.name;
          return `      - ${source}:${v.mountPath}${mountOptions(v)}`;
        })
        .join("\n") +
      "\n"
    : "";
  const topVolsYaml = namedVols.length
    ? "\nvolumes:\n" +
      namedVols
        .map(
          (v) => `  ${v.name}:\n    name: ${hostVolumeName(deployKey, v.name)}`,
        )
        .join("\n") +
      "\n"
    : "";
  // Resource-limit keys (mem_limit/cpus/pids_limit/…) at the service indent (4).
  // "" when the app has no limits ⇒ the fragment drops out, byte-identical.
  const resourcesYaml = renderResourceLimitsYaml(opts.resources, 4);
  // Same rule: "" when the app has no health check, so nothing changes for one
  // that never turned it on.
  const healthYaml = opts.healthCheckKeys
    ? renderYamlKeys({ healthcheck: opts.healthCheckKeys }, 4)
    : renderHealthCheckYaml(opts.healthCheck, opts.port, 4);

  return `# Generated by Deplo  ${deployKey}
services:
  ${name}:
    image: ${image}
    container_name: ${name}
    restart: unless-stopped
    networks:
      - deplo
${resourcesYaml}${healthYaml}${envYaml}${appVolsYaml}    labels:
${labelsYaml}

networks:
  deplo:
    external: true
${topVolsYaml}`;
}

/** A deployment status that is non-terminal - a build was in flight. */
export function isInFlightStatus(s: Deployment["status"]): boolean {
  return s === "queued" || s === "building";
}

/**
 * Reconcile deployments orphaned by a control-plane restart (PLAN D5, Part-A
 * half).
 */
export async function reconcileInFlightDeployments(): Promise<number> {
  const db = getDb();
  // Orphaned BUILDING deploys: the fire-and-forget job died with the process and
  // there is no agent-side abort, so the row would lie "building" forever.
  const orphaned = await db
    .select({
      id: deploymentsTable.id,
      appId: deploymentsTable.appId,
      // Joined so the alert below can be raised once PER TEAM instead of once
      // per row: a restart with twenty in-flight deploys is one thing that
      // happened, not twenty.
      teamId: appsTable.teamId,
    })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(appsTable.id, deploymentsTable.appId))
    .where(eq(deploymentsTable.status, "building"));
  if (orphaned.length > 0) {
    const affectedApps = new Set(orphaned.map((d) => d.appId));
    await db
      .update(deploymentsTable)
      .set({ status: "error" })
      .where(eq(deploymentsTable.status, "building"));
    for (const dep of orphaned) {
      log(
        dep.id,
        "error",
        "Deployment interrupted by a control-plane restart and marked failed.",
      );
    }
    await Promise.all(orphaned.map((d) => finalizeDeploymentLogs(d.id)));
    await db
      .update(appsTable)
      .set({ status: "error", updatedAt: nowIso() })
      .where(
        and(
          inArray(appsTable.id, [...affectedApps]),
          eq(appsTable.status, "building"),
        ),
      );
    for (const appId of affectedApps) publishAppChanged(appId);
    // One alert per team, not one per deployment: this is a bulk flip that
    // bypasses commitOutcome entirely, and a restart must not fan out N alerts.
    const perTeam = new Map<string, number>();
    for (const d of orphaned)
      perTeam.set(d.teamId, (perTeam.get(d.teamId) ?? 0) + 1);
    for (const [teamId, n] of perTeam)
      dispatchAlert({
        teamId,
        key: "deployment_interrupted",
        title: `${n} deployment${n > 1 ? "s were" : " was"} interrupted`,
        body: "Deplo restarted while they were building. Redeploy when ready.",
        path: "/deployments",
      });
    console.warn(
      `[deplo] reconciled ${orphaned.length} interrupted deployment(s) to error on startup`,
    );
  }
  // QUEUED deploys are DURABLE across a restart: no build ever started, so nothing
  // was lost.
  return orphaned.length;
}

/**
 * Create a deployment record (queued) and kick off the real build in the
 * background. Returns the deployment id immediately; the job updates status and
 * logs as it progresses.
 */
export async function startDeployment(
  appId: string,
  opts: {
    environment?: DeploymentEnvironment;
    creator: string;
    commitMessage?: string;
    branch?: string;
    /**
     * Replace the running containers even when the rendered stack is unchanged
     * ("Rebuild container"). Stored on the row because the deploy runs later, out
     * of the queue, in a call stack that has nothing left of this request.
     */
    forceRecreate?: boolean;
    /**
     * The pull request preview this build belongs to.
     */
    preview?: {
      id: string;
      deployKey: string;
      host: string;
      certProvider: CertProvider;
      prNumber: number;
      /** The commit the preview is being built at (informational on the row). */
      headSha?: string;
      /** Where previews of this app run. Empty ⇒ the app's own server. */
      serverId?: string | null;
    } | null;
    /**
     * This build is a ROLLBACK to a deployment that already succeeded: it re-runs
     * that build's image instead of producing a new one, so there is no clone, no
     * build and no pull - seconds instead of minutes.
     */
    rollback?: {
      /** The deployment being returned to (recorded as `rollback_of`). */
      deploymentId: string;
      /** Its `image_ref` - the tag on the owning host this deploy will run. */
      imageRef: string;
      commitSha: string;
      commitMessage: string;
      commitAuthor: string;
      /** When the build being returned to was made - the only thing that names it
       *  in the Activity trail when the source has no commit sha (an upload). */
      builtAt: string;
    } | null;
  },
): Promise<string> {
  const project = await loadAppGraph(appId);
  if (!project) throw new Error("App not found");
  const preview = opts.preview ?? null;
  // Data a migration could not copy is a refusal, not a warning: the volumes it names
  // are empty or half-written, and deploying onto them is what turns a failed copy
  // into permanent loss.
  if (!preview) assertDataCopyIntact(project.name, project.dataCopyError);
  // Still being created by a migration. Here as well as in the capability gate,
  // because the git webhook reaches this function with no gate at all: a push
  // landing mid-import would deploy an app whose volumes are still filling.
  assertNotMigrating("app", project.name, project.migrationRunId);
  const rollback = opts.rollback ?? null;
  const environment = opts.environment ?? (preview ? "preview" : "production");
  if (preview && environment !== "preview") {
    throw new Error("A preview deployment must use the preview environment");
  }
  // A preview is an ephemeral stack of ITS OWN commit; there is no "the previous
  // one" to return it to, and its key/host belong to a pull request. Refuse rather
  // than let a caller combine the two into a deploy nobody can reason about.
  if (rollback && preview) {
    throw new Error("A pull request preview cannot be rolled back");
  }
  const branch = opts.branch ?? project.repo?.branch ?? "main";
  // Production routes through the project's EXISTING registered primary domain
  // (created once at project creation).
  const primaryRow = preview ? null : await primaryDomainRow(appId);
  const domain = preview ? preview.host : (primaryRow?.name ?? "");
  // No production domain ⇒ no canonical URL.
  const scheme = preview
    ? domainScheme({ certProvider: preview.certProvider })
    : primaryRow
      ? domainScheme(primaryRow)
      : "https";
  const url = domain ? `${scheme}://${domain}` : "";
  const depId = newId("dpl");
  // The stack this build owns. Production keeps the bare app slug, which is why
  // introducing the key changed nothing that was already running.
  const deployKey = preview ? preview.deployKey : project.slug;

  const dep: Deployment = {
    id: depId,
    appId,
    status: "queued",
    environment,
    deployKey,
    previewId: preview?.id ?? null,
    prNumber: preview?.prNumber ?? null,
    // A rollback re-runs a build that already happened, so it inherits that
    // build's commit rather than inventing one: the list has to keep saying which
    // code is live, and after a rollback that is the OLD commit.
    commitSha: rollback?.commitSha ?? "",
    commitMessage: rollback?.commitMessage || opts.commitMessage || "Deploy",
    commitAuthor: rollback?.commitAuthor || opts.creator,
    branch,
    url,
    createdAt: nowIso(),
    // Not started: the row is queued, and the claim below stamps the real start.
    startedAt: null,
    readyAt: null,
    buildDurationMs: null,
    forceRecreate: opts.forceRecreate ?? false,
    // A rollback carries the image it is going back to and the row it came from.
    // Both are what `runDeployment` reads to take the no-build path.
    imageRef: rollback?.imageRef ?? null,
    rollbackOf: rollback?.deploymentId ?? null,
    creator: opts.creator,
    // WHO `creator` names, when it names somebody with an account here.
    creatorUserId: await resolveActorUserId(opts.creator),
    creatorUser: null,
    serverId: preview?.serverId || project.serverId,
    // Resolved just below, once the target server row is in hand.
    buildServerId: null,
  };

  // Insert the deployment, then point its OWNER at it (latestDeployment + queued).
  // Everything downstream reads the row, never the app.
  const deployServerId = preview?.serverId || project.serverId;
  // Which host COMPILES this one, decided here and written down for the same reason
  // `serverId` is: from this point everything reads the row.
  const buildServerId = rollback
    ? null
    : await resolveBuildServerFor(project, deployServerId, depId);
  await getDb()
    .insert(deploymentsTable)
    .values({
      ...deploymentToRow(dep),
      serverId: deployServerId,
      buildServerId,
    });
  await clearDeploymentLogs(depId);
  if (preview) {
    // A preview NEVER touches the App's row.
    await getDb()
      .update(appPreviewsTable)
      .set({
        latestDeploymentId: depId,
        status: "queued",
        url,
        ...(opts.preview?.headSha ? { headSha: opts.preview.headSha } : {}),
        lastActivityAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(eq(appPreviewsTable.id, preview.id));
  } else {
    await getDb()
      .update(appsTable)
      .set({
        latestDeploymentId: depId,
        status: "queued",
        updatedAt: nowIso(),
        productionUrl: domain ? url : null,
      })
      .where(eq(appsTable.id, appId));
  }
  await recordActivity(
    "deployment",
    preview
      ? `Deploying ${project.name} preview for pull request #${preview.prNumber}`
      : rollback
        ? // Name the commit, not the deployment id: "who put us back on what" is
          // the question the trail gets asked, and a `dpl_` id answers neither
          // half. An uploaded archive has no sha, so it falls back to the date the
          // build it is returning to was made.
          `Rolling ${project.name} back to ${
            rollback.commitSha
              ? rollback.commitSha.slice(0, 7)
              : `the build from ${rollback.builtAt.slice(0, 10)}`
          }`
        : `Deploying ${project.name}`,
    opts.creator,
    appId,
  );

  // Supersede: a newer trigger for the SAME STACK wins, so cancel any of its
  // still-QUEUED deploys that haven't started yet (nothing was built - safe to drop)
  // EXCEPT the one just inserted.
  await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled" })
    .where(
      and(
        eq(deploymentsTable.appId, appId),
        eq(deploymentsTable.deployKey, deployKey),
        eq(deploymentsTable.status, "queued"),
        ne(deploymentsTable.id, depId),
      ),
    );

  // A new deployment flips its owner to "queued" and sets latestDeployment -
  // push it to live subscribers so the header/tabs (and the pull requests list)
  // update without a reload.
  publishAppChanged(appId);

  // Hand the queued deploy to the per-server queue instead of firing it inline: it
  // starts once its OWNING server has a free slot (default 1) and no other deploy of
  // this app is in flight.
  enqueueDeployment({ depId, serverId: deployServerId, appId, buildServerId });
  return depId;
}

/**
 * Run a queued deployment to completion for the deploy queue, flushing a clean
 * terminal error if `runDeployment`'s pre-try setup throws (it finalizes its own
 * logs in a finally otherwise).
 */
export async function runDeploymentGuarded(depId: string): Promise<void> {
  try {
    await runDeployment(depId);
  } catch (e) {
    log(depId, "error", e instanceof Error ? e.message : String(e));
    await setDep(depId, { status: "error" }, { onlyIfNotCanceled: true });
    await finalizeDeploymentLogs(depId);
  }
}

/**
 * Render the single-image (or compose) stack and stream it through the OWNING
 * agent.
 */
/** The agent attempt's outcome + any commit sha the agent resolved (git source). */
interface AgentAttempt {
  outcome: "agent" | "failed";
  commitSha: string;
}

/**
 * Whether a plan actually compiles something. Only these two can be split across a
 * build server: a prebuilt `image` has nothing to build, and a `compose` stack has
 * no single image to move (its services come up from their own).
 */
function planBuilds(plan: AgentBuildPlan): boolean {
  return plan.kind === "git" || plan.kind === "dockerfile";
}

/**
 * The build server for a deploy about to be queued, or null for "build where it
 * runs". Choosing where to compile must not be able to stop an app from shipping.
 */
async function resolveBuildServerFor(
  project: { teamId: string; serverId: string; buildServerId?: string | null },
  deployServerId: string,
  depId: string,
): Promise<string | null> {
  try {
    const target = await getServerById(deployServerId);
    if (!target) return null;
    const choice = await resolveBuildServer(
      {
        teamId: project.teamId,
        serverId: project.serverId,
        buildServerId: project.buildServerId ?? null,
      },
      target,
    );
    return choice.serverId;
  } catch (e) {
    console.error(`[deplo] build server lookup failed for ${depId}:`, e);
    return null;
  }
}

/**
 * The one line the deploy log gets about where this app compiled, derived from the
 * row rather than re-run - the decision was made at enqueue time and the row is
 * the authority on it, exactly as it is for `serverId`.
 */
async function explainBuildServer(
  project: { serverId: string; buildServerId?: string | null },
  dep: { buildServerId: string | null },
  target: { id: string; name: string; hostArch: string },
): Promise<{ level: LogLine["level"]; text: string } | null> {
  if (dep.buildServerId) {
    const builder = await getServerById(dep.buildServerId);
    return buildServerLogLine(
      {
        serverId: dep.buildServerId,
        reason: project.buildServerId ? "pinned" : "automatic",
      },
      builder?.name ?? dep.buildServerId,
      target.name,
    );
  }
  const pinned = project.buildServerId;
  if (!pinned || pinned === project.serverId || pinned === target.id)
    return null;
  // The pin did not apply. One extra lookup, only on this rare path, so the message
  // can name the actual reason instead of a shrug.
  const server = await getServerById(pinned);
  const reason =
    server && server.hostArch !== target.hostArch
      ? "arch-mismatch"
      : "none-available";
  return buildServerLogLine(
    { serverId: null, reason },
    server?.name ?? pinned,
    target.name,
  );
}

/**
 * Whether an error means "that host did not answer / cannot do this", across BOTH
 * classes that mean it. Matching only the second is how a fallback that exists
 * precisely for "the build server is down" ends up never firing for it.
 */
function agentIsDown(e: unknown): boolean {
  return (
    e instanceof AgentUnavailableError || e instanceof AgentUnreachableError
  );
}

/**
 * What the deploy log is allowed to say about a host that did not answer.
 */
function agentDownReason(e: unknown): string {
  if (e instanceof AgentUnavailableError) {
    // These messages are ours, written at the throw site, and carry no address.
    return e.message;
  }
  // A TRUST failure is not a dead host: the peer answered, it just is not the agent
  // Deplo pinned (or it rejected our client cert). Saying "it did not answer" would
  // send someone to check whether the box is up, which is the one thing that is fine.
  if (e instanceof AgentUnreachableError && e.trust) {
    return "its certificate is not the one Deplo trusts - reissue its install command";
  }
  return "it did not answer";
}

/**
 * The build half of a split deploy: compile on the build server, then stream the
 * image to the host that will run it.
 */
async function buildOnBuildServer(opts: {
  depId: string;
  serverId: string;
  buildServerId: string;
  buildServerName?: string;
  targetServerName?: string;
  buildFallbackLocal?: boolean;
  project: { id: string; deployKey: string; composeUpArgs: string | null };
  imageRef: string;
  composeYaml: string;
  env: Record<string, string>;
  plan: AgentBuildPlan;
  noCache?: boolean;
  sink: (level: LogLine["level"], text: string) => void;
}): Promise<{ outcome: "built" | "fallback" | "failed"; commitSha: string }> {
  const builderName = opts.buildServerName ?? "the build server";
  const targetName = opts.targetServerName ?? "the app's server";

  let commitSha = "";
  try {
    const built = await runAgentDeploy({
      serverId: opts.buildServerId,
      deployId: opts.depId,
      slug: opts.project.deployKey,
      appId: opts.project.id,
      imageRef: opts.imageRef,
      // The builder writes no stack and starts nothing, so the rendered compose is inert
      // there.
      composeYaml: opts.composeYaml,
      env: opts.env,
      plan: opts.plan,
      noCache: opts.noCache,
      buildOnly: true,
      sink: { log: opts.sink },
    });
    if (!built.ready) return { outcome: "failed", commitSha: built.commitSha };
    commitSha = built.commitSha;
  } catch (e) {
    if (agentIsDown(e)) {
      console.error(
        `[deplo] build server ${opts.buildServerId} unavailable:`,
        e,
      );
      const why = agentDownReason(e);
      if (opts.buildFallbackLocal !== false) {
        opts.sink(
          "warn",
          `${builderName} could not be reached (${why}). Building on ${targetName} instead.`,
        );
        return { outcome: "fallback", commitSha: "" };
      }
      opts.sink(
        "error",
        `${builderName} could not be reached (${why}), and this app is set not to ` +
          `build on ${targetName}. The running version was not touched.`,
      );
      return { outcome: "failed", commitSha: "" };
    }
    throw e;
  }

  // The image exists on the builder and nowhere else. From here a failure is a
  // failure: the build already happened, and repeating it on a host chosen for
  // being small is the outcome the build server exists to avoid.
  try {
    const bytes = await relayBuiltImage(
      opts.buildServerId,
      opts.serverId,
      opts.imageRef,
    );
    opts.sink(
      "info",
      `Copied ${formatBytes(bytes)} from ${builderName} to ${targetName}`,
    );
    return { outcome: "built", commitSha };
  } catch (e) {
    console.error(
      `[deplo] image copy ${opts.buildServerId} -> ${opts.serverId} failed:`,
      e,
    );
    // AgentVolumeCopyUnsupportedError's text is ours ("update the agent on the
    // <side> server") and is the one thing worth repeating; anything else is a
    // transport error whose text is not safe to show.
    const why =
      e instanceof AgentVolumeCopyUnsupportedError
        ? e.message
        : "the transfer did not complete";
    opts.sink(
      "error",
      `Could not copy the built image from ${builderName} to ${targetName}: ${why}. ` +
        `The running version was not touched.`,
    );
    return { outcome: "failed", commitSha };
  }
}

/** Open one connection to each host and relay the image between them, closing both
 *  however it ends. The bytes pass through the control plane because agents cannot
 *  dial each other - the same path a cross-host volume copy takes. */
async function relayBuiltImage(
  buildServerId: string,
  targetServerId: string,
  imageRef: string,
): Promise<number> {
  const source = await connectAgent(buildServerId);
  try {
    const dest = await connectAgent(targetServerId);
    try {
      return await copyImageBetween(source, dest, imageRef);
    } finally {
      dest.close();
    }
  } finally {
    source.close();
  }
}

async function tryAgent(opts: {
  depId: string;
  serverId: string;
  project: { id: string; deployKey: string; composeUpArgs: string | null };
  imageRef: string;
  composeYaml: string;
  env: Record<string, string>;
  plan: AgentBuildPlan;
  /** How long the agent waits for the stack to report running (ms). Defaults to
   * 60s (the single-image path); the compose path passes 90s since a multi-service
   * stack may pull several images first. */
  readyTimeoutMs?: number;
  /** Build this one without the host's layer cache (see `noCacheForDeploy`). */
  noCache?: boolean;
  /** Recreate the containers even if the stack is unchanged ("Rebuild container"). */
  forceRecreate?: boolean;
  /** The BUILD SERVER this deploy compiles on, when that is not `serverId`. Null
   *  (the ordinary case) builds and runs on the same host, exactly as before. */
  buildServerId?: string | null;
  /** Human name of the build server, for the log lines. */
  buildServerName?: string;
  /** Human name of the target server, for the log lines. */
  targetServerName?: string;
  /** Build on the target instead when the build server cannot be reached. */
  buildFallbackLocal?: boolean;
}): Promise<AgentAttempt> {
  // Serialize the agent bring-up against deleteApp/deleteApps on the app's lifecycle
  // lock (the same mutex the databases use for provision/delete).
  return withKeyedLock(`app-lifecycle:${opts.project.id}`, async () => {
    const stillExists = await getDb()
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(eq(appsTable.id, opts.project.id))
      .limit(1);
    if (stillExists.length === 0) {
      log(
        opts.depId,
        "error",
        "App was deleted during the build - deploy aborted.",
      );
      return { outcome: "failed", commitSha: "" };
    }
    // The plan the TARGET runs, and the commit the BUILD resolved. Both are only
    // rewritten by the build-server leg below; without one they stay as passed and
    // this function behaves exactly as it always did.
    let plan = opts.plan;
    let builtCommitSha = "";
    try {
      if (
        opts.buildServerId &&
        opts.buildServerId !== opts.serverId &&
        planBuilds(opts.plan)
      ) {
        const leg = await buildOnBuildServer({
          ...opts,
          buildServerId: opts.buildServerId,
          sink: (level: LogLine["level"], text: string) =>
            log(opts.depId, level, text),
        });
        if (leg.outcome === "failed")
          return { outcome: "failed", commitSha: leg.commitSha };
        if (leg.outcome === "built") {
          builtCommitSha = leg.commitSha;
          // The target now holds the image and runs it exactly as a ROLLBACK does:
          // a local tag, in no registry, so pulling it could only ever fail.
          plan = { kind: "image", image: opts.imageRef, pull: false };
        }
        // outcome "fallback": the builder was unreachable and this app allows a
        // local build. `plan` is untouched, so the target builds it itself.
      }

      const { ready, commitSha } = await runAgentDeploy({
        serverId: opts.serverId,
        deployId: opts.depId,
        slug: opts.project.deployKey,
        appId: opts.project.id,
        imageRef: opts.imageRef,
        composeYaml: opts.composeYaml,
        env: opts.env,
        plan,
        readyTimeoutMs: opts.readyTimeoutMs ?? 60_000,
        noCache: opts.noCache,
        forceRecreate: opts.forceRecreate,
        // The app's own extra flags for the bring-up, split into argv tokens.
        composeUpArgs: parseComposeUpArgs(opts.project.composeUpArgs),
        sink: { log: (level, text) => log(opts.depId, level, text) },
      });
      // A release of an already-built image reports no commit - the build did, one
      // host ago. Prefer what the build resolved so the row still records the sha
      // that is actually running.
      return {
        outcome: ready ? "agent" : "failed",
        commitSha: commitSha || builtCommitSha,
      };
    } catch (e) {
      if (agentIsDown(e)) {
        // No in-process build path to fall back to: surface the unreachable agent as a
        // clear deploy failure (P5 - no hung deploys).
        console.error(`[deplo] agent ${opts.serverId} unavailable:`, e);
        log(opts.depId, "error", `Agent unavailable: ${agentDownReason(e)}`);
        return { outcome: "failed", commitSha: "" };
      }
      throw e;
    }
  });
}

async function runDeployment(depId: string): Promise<void> {
  const started = Date.now();
  const dep = await loadDeployment(depId);
  if (!dep) return;
  const project = await loadAppGraph(dep.appId);
  if (!project) {
    await setDep(depId, { status: "error" }, { onlyIfNotCanceled: true });
    return;
  }
  // THE stack this deploy owns.
  const deployKey = dep.deployKey || project.slug;
  const preview = dep.previewId
    ? await loadPreviewForDeploy(dep.previewId)
    : null;
  const name = stackName(deployKey);
  // The row, not the app: a preview may be pinned to a different machine, and
  // the row is what the queue already drained on.
  const runServerId = dep.serverId || project.serverId;
  const target = targetFor(dep, project);
  // The `deplo.project` label value: an App id for production, the PREVIEW's own id
  // for a preview.
  const trackingId = preview ? preview.id : project.id;
  // Production routes through the project's EXISTING registered primary domain (never
  // resurrected - see startDeployment).
  const domain = preview ? preview.host : await primaryDomainName(project.id);
  // Production routes to every verified domain (primary first); a preview uses only
  // its own host (which is never a registered `domains` row - that would leak it into
  // the PRODUCTION router set and into the per-team certificate quota).
  const routeDomains = await routableForDeploy(
    project.id,
    dep.environment,
    domain,
    preview?.certProvider,
    preview ? await previewRouteTarget(project, preview.port) : undefined,
  );

  // Claim the deploy: queued -> building, but ONLY while it is still queued. The
  // terminal commitOutcome CAS only covers a cancel that arrives DURING the build -
  // this covers the window before it starts.
  const claimed = await getDb()
    .update(deploymentsTable)
    .set({ status: "building", startedAt: new Date(started).toISOString() })
    .where(
      and(
        eq(deploymentsTable.id, depId),
        eq(deploymentsTable.status, "queued"),
      ),
    )
    .returning({ id: deploymentsTable.id });
  if (claimed.length === 0) {
    await settleIfCanceled(depId, target);
    await finalizeDeploymentLogs(depId);
    return;
  }
  publishAppChanged(project.id);
  await setDeployState(target, { status: "building" });

  try {
    // Nothing host-local happens here any more, and that is the point: this was the
    // LAST live line in the control plane that reached a Docker socket (ADR-0006 says
    // there should be none).

    // The agent now runs EVERY build method (Dockerfile family + the heavy builders
    // static/nixpacks/buildpacks/railpack, ported to deplo-agent). That check is below
    // (after the compose branch), keyed on agentCapabilityForMethod.

    // Freshness for THIS deploy: whether it may read the server's build cache (the
    // app's Build cache setting, plus any armed one-shot clear), and whether the
    // containers must be replaced even when the rendered stack is identical ("Rebuild
    // container").
    const { noCache, reason: noCacheReason } = noCacheForDeploy(project.build);
    const forceRecreate = dep.forceRecreate;

    // Multi-service compose / one-click template deploy: deploy the project's own
    // compose stack, wired to Traefik on the generated domain.
    const hasCompose = Boolean(project.compose && project.compose.trim());
    const useCompose = usesComposeStack(project);
    // A ROLLBACK must never reach the compose branch. It would bring the CURRENT stack
    // up, settle `ready`, and leave a row that says it went back to an old commit -
    // success reported for something that did not happen.
    if (useCompose && dep.rollbackOf) {
      log(
        depId,
        "error",
        "This app deploys a compose stack now, so there is no single image to roll back to.",
      );
      await commitOutcome(
        depId,
        target,
        { status: "error", buildDurationMs: Date.now() - started },
        { status: "error" },
      );
      return;
    }
    if (useCompose && hasCompose) {
      const composeOpts = {
        depId,
        project,
        name,
        deployKey,
        trackingId,
        target,
        domain,
        forceRecreate,
        // Compose stacks route via their own service/port model (expose/exposes + host
        // pins).
        domains: routeDomains.map((d) => d.name),
        domainRoutes: routeDomains,
        environment: dep.environment,
        preview: preview
          ? {
              host: domain,
              url: dep.url,
              branch: dep.branch,
              prNumber: preview.prNumber,
              isFork: preview.isFork,
            }
          : null,
        started,
      };
      // The owning agent runs the stack (it writes the mount files + env-file and
      // `compose up`s on its host), the host running Deplo included. The control
      // plane renders the stack YAML (buildComposeStack); the agent brings it up.
      await deployComposeStackViaAgent({
        ...composeOpts,
        serverId: runServerId,
      });
      // Auto-set the display logo when the app has none yet - the compose-stack arm of
      // the same detection git/upload apps get. PRODUCTION ONLY: this writes the APP's
      // logo.
      if (!preview) {
        autoDetectComposeLogo(
          project.id,
          project.logo,
          project.serverId,
          deployKey,
          appIconProbeTarget(project, routeDomains, domain),
        );
      }
      return;
    }

    let imageRef: string;
    let commitSha = "";
    // Set by the agent path when it fully built + ran this deploy.
    let agentOutcome: "agent" | "failed" | null = null;
    const serverId = runServerId;

    // Where this deploy COMPILES, read off the row for the same reason `serverId` is:
    // the choice was made when the deploy was queued and the row is what the queue
    // already drained on.
    const targetServer = await getServerById(serverId);
    const buildServer = dep.buildServerId
      ? await getServerById(dep.buildServerId)
      : null;
    const buildServerOpts = {
      buildServerId: dep.buildServerId,
      buildServerName: buildServer?.name,
      targetServerName: targetServer?.name ?? "the app's server",
      buildFallbackLocal: project.buildFallbackLocal,
    };
    if (targetServer) {
      const line = await explainBuildServer(project, dep, targetServer);
      if (line) log(depId, line.level, line.text);
    }

    // Per-server build-method capability gate. Gate on the advertised capability and
    // fail with an actionable "update the agent" message instead (mirrors the
    // compose.multi gate + P5's fail-fast-on-an-incapable-agent discipline).
    const requiredCapability = dep.rollbackOf
      ? null
      : agentCapabilityForMethod(project.build);
    // The capability belongs to whichever host actually RUNS the builder. With a
    // build server that is the builder, not the target: gating the target on a
    // method it will never invoke would refuse a deploy for the wrong host's age.
    const capServerId = dep.buildServerId || serverId;
    if (requiredCapability) {
      try {
        const hello = await agentPreflight(capServerId);
        if (!hello.capabilities.includes(requiredCapability)) {
          log(
            depId,
            "error",
            `${dep.buildServerId ? "The build server's" : "This server's"} agent is too ` +
              `old to run the ${project.build.buildMethod} build method. Update the agent ` +
              `(reissue the install command from the server's actions menu).`,
          );
          await commitOutcome(
            depId,
            target,
            { status: "error", buildDurationMs: Date.now() - started },
            { status: "error" },
          );
          return;
        }
      } catch (e) {
        // An unreachable BUILD SERVER is not decided here.
        if (!dep.buildServerId) {
          log(
            depId,
            "error",
            `Agent unavailable: ${e instanceof Error ? e.message : String(e)}`,
          );
          await commitOutcome(
            depId,
            target,
            { status: "error", buildDurationMs: Date.now() - started },
            { status: "error" },
          );
          return;
        }
      }
    }

    // Render the single-image stack the agent brings up. The control plane stays
    // the single source of truth for the compose (D2) and env decryption (D4);
    // both are computed here, once, and handed to the agent.
    const renderStack = async (
      image: string,
    ): Promise<{ composeYaml: string; env: Record<string, string> }> => {
      const env = await appEnv(project.id, dep.environment, {
        preview: preview
          ? {
              host: domain,
              url: dep.url,
              branch: dep.branch,
              prNumber: preview.prNumber,
              isFork: preview.isFork,
            }
          : null,
      });
      const basicAuthUsers = await basicAuthUsersValue(project.id);
      const composeYaml = renderCompose({
        name,
        image,
        port: project.build.port,
        appId: project.id,
        deployKey,
        trackingId,
        routes: routeDomains,
        env,
        basicAuthUsers,
        // A prebuilt image is deployed as-is, never inject PORT and override the
        // listen address its author baked in. Built sources (git/upload/
        // dockerfile) DO get PORT so 12-factor apps bind where Traefik forwards.
        injectPort: project.source !== "docker-image",
        // The deploy path is the only writer of volumes into the stack - sourced
        // from the project. A reroute reads them back from the file instead.
        volumes: project.volumes ?? [],
        // Per-app resource caps, baked into the rendered compose at deploy time
        // (like volumes). Null ⇒ no keys emitted.
        resources: project.resources,
        healthCheck: project.healthCheck,
      });
      return { composeYaml, env };
    };

    // For a BUILT source (git/upload): resolve the build dir (one shared rootDirectory
    // containment), then ship the materialised tree to the owning agent, which builds +
    // runs it.
    const buildAndMaybeAgent = async (treeOpts: {
      workDir: string;
      root: string;
      imageRef: string;
      /** Hard-fail on an explicit-but-missing rootDirectory (git); upload doesn't. */
      failOnMissing: boolean;
      notFoundMessage?: string;
    }): Promise<void> => {
      // Only the rootDirectory containment happens here - the agent does the build.
      const buildDir = await resolveBuildDir({
        root: treeOpts.root,
        rootDirectory: project.build.rootDirectory,
        failOnMissing: treeOpts.failOnMissing,
        notFoundMessage: treeOpts.notFoundMessage,
      });
      const { composeYaml, env } = await renderStack(treeOpts.imageRef);
      const { outcome } = await tryAgent({
        depId,
        serverId,
        project: {
          id: project.id,
          deployKey,
          composeUpArgs: project.composeUpArgs,
        },
        imageRef: treeOpts.imageRef,
        composeYaml,
        env,
        plan: {
          kind: "dockerfile",
          buildDir,
          build: normalizeBuildConfig(project.build),
        },
        noCache,
        forceRecreate,
        ...buildServerOpts,
      });
      agentOutcome = outcome === "agent" ? "agent" : "failed";
    };

    // Framework recognition is per-deploy and self-correcting.
    if (!canRecognizeFramework(project)) void setFramework(project.id, null);

    // Decide which source this deployment builds from (see planDeploySource).
    const plan: SourcePlan | { kind: "rollback"; image: string; of: string } =
      dep.rollbackOf && dep.imageRef
        ? { kind: "rollback", image: dep.imageRef, of: dep.rollbackOf }
        : planDeploySource(project);
    // A cache-less build is minutes slower than a cached one, so say why before the log
    // fills with build output, and spend the one-shot clear here, where a build is
    // genuinely about to run (a prebuilt image never builds, so its deploy must not
    // swallow the clear the user armed for the next real build).
    if (noCache && (plan.kind === "git" || plan.kind === "upload")) {
      log(depId, "info", noCacheReason);
      if (project.build.buildCacheClearPending)
        await consumeCacheClear(project.id);
    }
    switch (plan.kind) {
      case "rollback": {
        // Re-run an image THIS app already built. Only the image comes from the past:
        // rolling a password back because the code rolled back is not something anyone
        // asked for.
        imageRef = plan.image;
        log(
          depId,
          "info",
          `Rolling back to the image from deployment ${plan.of}`,
        );
        const { composeYaml, env } = await renderStack(imageRef);
        const { outcome } = await tryAgent({
          depId,
          serverId,
          project: {
            id: project.id,
            deployKey,
            composeUpArgs: project.composeUpArgs,
          },
          imageRef,
          composeYaml,
          env,
          plan: { kind: "image", image: imageRef, pull: false },
          forceRecreate,
        });
        agentOutcome = outcome === "agent" ? "agent" : "failed";
        break;
      }
      case "docker-image": {
        imageRef = plan.image;
        // A prebuilt image: the owning agent pulls + runs it on its host.
        const { composeYaml, env } = await renderStack(imageRef);
        const { outcome } = await tryAgent({
          depId,
          serverId,
          project: {
            id: project.id,
            deployKey,
            composeUpArgs: project.composeUpArgs,
          },
          imageRef,
          composeYaml,
          env,
          plan: { kind: "image", image: plan.image, pull: true },
          forceRecreate,
        });
        agentOutcome = outcome === "agent" ? "agent" : "failed";
        break;
      }
      case "git": {
        const repo = plan.repo;
        // Auto-set the display logo from a favicon/icon in the repo (via the GitHub API -
        // the tree is cloned on the agent, not here) when the app has none yet.
        // Fire-and-forget so a GitHub round-trip never delays the deploy.
        autoDetectRepoLogo(
          project.id,
          project.logo,
          repo,
          project.build.rootDirectory,
        );
        // Same read, same detached shape: name the framework backing the repo so
        // the app shows what it actually is (and its port default follows the
        // framework's own server). Only under the auto-detecting builders.
        if (canRecognizeFramework(project)) {
          autoDetectRepoFramework(
            project.id,
            repo,
            project.build.rootDirectory,
          );
        }
        // The OWNING AGENT clones the repo itself (PLAN Part B, D3), the host running Deplo
        // included, so the whole tree never crosses the wire - only the descriptor does.
        const forkUrl = preview?.isFork
          ? forkCloneUrl(repo.url, preview.headCloneUrl)
          : null;
        // Say WHY the clone is about to fail, before it does.
        if (!forkUrl) {
          const refusal = await repoCloneRefusal(repo);
          if (refusal) throw new Error(refusal);
        }
        const cloneUrl = forkUrl ?? (await resolveCloneUrl(repo));
        // One tag per deployment, and the agent builds under exactly this string - it
        // resolves the commit sha but never retags with it.
        imageRef = deployImageRef(deployKey, depId);
        await setDep(depId, { imageRef });
        const { composeYaml, env } = await renderStack(imageRef);
        // The credential-free address, as it has always been logged: `cloneUrl`
        // carries an installation token for a private repo, and a deploy log is
        // readable by anyone with `view_logs`.
        log(
          depId,
          "command",
          `git clone ${forkUrl ?? repo.url} (${dep.branch}) [on agent]`,
        );
        const attempt = await tryAgent({
          depId,
          serverId,
          project: {
            id: project.id,
            deployKey,
            composeUpArgs: project.composeUpArgs,
          },
          imageRef,
          composeYaml,
          env,
          plan: {
            kind: "git",
            url: cloneUrl,
            branch: dep.branch,
            subdir: project.build.rootDirectory ?? "",
            build: normalizeBuildConfig(project.build),
          },
          noCache,
          forceRecreate,
          ...buildServerOpts,
        });
        if (attempt.commitSha) {
          commitSha = attempt.commitSha;
          await setDep(depId, { commitSha });
        }
        agentOutcome = attempt.outcome === "agent" ? "agent" : "failed";
        break;
      }
      case "upload": {
        // Uploaded archive: extract into a temp dir, then build through the same path as a
        // git clone. extractArchive rejects any symlink in the archive (so none can be
        // followed out of the temp dir) and may return a subdir (a tarball wrapped in one
        // top-level folder).
        const upload = plan.upload;
        const work = await mkdtemp(join(tmpdir(), "deplo-build-"));
        try {
          log(depId, "command", `extract ${upload.filename}`);
          const root = await extractArchive(upload, work, (line) =>
            log(depId, "info", line),
          );
          // Same per-deployment tag as the git arm, recorded for the same reason:
          // an uploaded archive builds a real image, so it accrues rollbacks too.
          imageRef = deployImageRef(deployKey, depId);
          await setDep(depId, { imageRef });
          // Auto-set the display logo from an icon/favicon in the extracted tree
          // when the app has none yet (reusing this tree, no re-extract).
          await autoDetectLogoFromTree(
            project.id,
            project.logo,
            root,
            project.build.rootDirectory,
          );
          // And name the framework from that same tree (one directory read).
          if (canRecognizeFramework(project)) {
            await autoDetectFrameworkFromTree(
              project.id,
              root,
              project.build.rootDirectory,
            );
          }
          await buildAndMaybeAgent({
            workDir: work,
            root,
            imageRef,
            failOnMissing: false,
          });
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
        break;
      }
      default:
        throw new Error("Nothing to deploy: no Docker image or repository set");
    }

    // The agent built, rendered, ran, and waited - settle the deploy from its
    // terminal result. Every source arm above goes through the agent, so
    // `agentOutcome` is always set by the time we get here.
    const buildDurationMs = Date.now() - started;
    if (agentOutcome === "agent") {
      // commitOutcome's CAS discards this success if a "Stop build" already
      // claimed the row (settling the app to idle); the ready log + the
      // data-migration hook then run ONLY when the outcome actually applied.
      const applied = await commitOutcome(
        depId,
        target,
        {
          status: "ready",
          readyAt: nowIso(),
          buildDurationMs,
          commitSha: commitSha || dep.commitSha,
        },
        {
          status: "active",
          // No domain ⇒ dep.url is "" ⇒ null productionUrl (the container ran but
          // is unrouted until a domain is added back).
          ...(dep.environment === "production"
            ? { productionUrl: dep.url || null }
            : {}),
        },
        { rollback: Boolean(dep.rollbackOf) },
      );
      if (applied) {
        log(
          depId,
          "success",
          dep.url
            ? `Deployment ready at ${dep.url}`
            : "Deployment ready (no domain - add one to route traffic)",
        );
        // If this PRODUCTION deploy landed on a NEW server after a move, copy the data
        // across now that the fresh stack + empty volumes exist on the new host. Errors are
        // surfaced into the deploy log but never fail the (already-successful) deploy.
        if (dep.environment === "production") {
          await completePendingAppMigration(project.id, (level, text) =>
            log(depId, level, text),
          ).catch((e) =>
            log(
              depId,
              "warn",
              `data migration step failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
        await sweepAfterDeploy(depId, serverId);
      }
    } else {
      await commitOutcome(
        depId,
        target,
        { status: "error", buildDurationMs },
        { status: "error" },
      );
    }
  } catch (e) {
    log(depId, "error", e instanceof Error ? e.message : String(e));
    // A cancel that raced the failure wins: commitOutcome's CAS keeps `canceled`.
    await commitOutcome(
      depId,
      target,
      { status: "error", buildDurationMs: Date.now() - started },
      { status: "error" },
    );
  } finally {
    // GUARANTEED final flush (PLAN §6 Decision 18): every deploy end/error path -
    // success, build failure, agent-unavailable, a thrown error, or an early return
    // inside the try - persists the buffered build logs before the fire-and-forget job
    // exits, instead of relying on the periodic timer.
    await finalizeDeploymentLogs(depId);
  }
}

/**
 * Deploy a project's docker-compose stack (templates / multi-service apps).
 * Writes the stack and an env-file next to it, brings it up wired to Traefik on
 * the generated domain, and waits for the exposed service to come up.
 */
interface ComposeStackApp {
  id: string;
  /** Named so a terminal alert can say whose deploy it was - the full app row is
   * what callers actually pass, so these are already there at runtime. */
  teamId: string;
  name: string;
  slug: string;
  compose: string | null;
  /** The app's extra flags for the `compose up`, as stored (null ⇒ none). */
  composeUpArgs?: string | null;
  mounts?: { filePath: string; content: string }[] | null;
  /** Per-app resource caps applied to every service in the stack (existing-wins). */
  resources?: ResourceLimits | null;
  /** Storage-settings volumes, mounted into the compose service each one names. */
  volumes?: VolumeMount[] | null;
}

interface ComposeStackOpts {
  depId: string;
  project: ComposeStackApp;
  name: string;
  /** The stack key: the app slug for production, `<slug>__pr-<n>` for a preview. */
  deployKey: string;
  /** The `deplo.project` label value - the app id, or a preview's own id. */
  trackingId: string;
  /** Where this deploy's live state is written (the App, or its preview row). */
  target: DeployTarget;
  /** The pull request preview context, when this stack IS one. */
  preview: PreviewEnvContext | null;
  domain: string;
  /** Public hostnames to route, primary first (no-host routes answer on all). */
  domains: string[];
  /** Every routable domain (the SOLE source of compose routing): each is one
   * Traefik router → its named compose service, on its port + path. Empty ⇒ the
   * stack is built and run but no routers are emitted (unrouted). */
  domainRoutes: RoutableDomain[];
  environment: DeploymentEnvironment;
  started: number;
  /**
   * Recreate the stack's containers even when the rendered YAML is unchanged
   * ("Rebuild container").
   */
  forceRecreate: boolean;
}

/**
 * The host directory a project's compose stack reads its template config files
 * (mounts) from. buildComposeStack rewrites every `./<x>` bind source to
 * `<filesDir>/<x>`, so this path is baked into the rendered YAML, and MUST be the
 * same on whichever host runs the stack.
 */
function composeFilesDir(deployKey: string): string {
  return stackFilesDir(deployKey);
}

/**
 * Register the extra hostnames a multi-domain template exposes and render the
 * project's compose stack to deployable YAML.
 */
async function prepareComposeStack(opts: ComposeStackOpts): Promise<{
  stackYaml: string;
  filesDir: string;
}> {
  const { project, name, deployKey, trackingId, domainRoutes } = opts;

  // A multi-domain template's extra hostnames are registered ONCE at project creation
  // (createApp), NOT here - a deploy never creates domain rows, so an extra domain
  // the user deletes is never resurrected on the next deploy.

  const filesDir = composeFilesDir(deployKey);
  const basicAuthUsers = await basicAuthUsersValue(project.id);
  // The settings env-var NAMES injected into every service as bare `- KEY`
  // pass-throughs - the value itself rides the env-file the agent writes (see
  // deployComposeStackViaAgent), so no secret lands in the rendered YAML.
  const envKeys = await appEnvKeys(project.id, opts.environment, {
    preview: opts.preview,
  });
  const stackYaml = buildComposeStack({
    compose: project.compose ?? "",
    name,
    deployKey,
    // A preview publishes no host ports - see ComposeStackInput. Production is
    // untouched, so its render stays byte-identical.
    stripPublishedPorts: Boolean(opts.preview),
    appId: project.id,
    trackingId,
    domainRoutes,
    filesDir,
    basicAuthUsers,
    envKeys,
    // Per-app caps applied to every service (existing-wins). Null ⇒ no-op.
    resources: project.resources,
    // Storage-settings volumes, mounted into the service each one names.
    volumes: project.volumes,
  });
  return { stackYaml, filesDir };
}

/** Apply the terminal status of a compose-stack deploy (via the owning agent). */
async function finishComposeStack(
  opts: ComposeStackOpts & { serverId: string },
  running: boolean,
): Promise<void> {
  const { depId, project, domain, environment, started, target } = opts;
  const buildDurationMs = Date.now() - started;
  // No domain ⇒ no URL: the stack ran but is unrouted until a domain is added.
  const domainRoute = opts.domainRoutes.find((r) => r.name === domain);
  const url = domain
    ? `${domainRoute && !domainRoute.tls ? "http" : "https"}://${domain}`
    : "";
  // commitOutcome honors a "Stop build" pressed while the stack came up (covers every
  // finishComposeStack caller: success, agent-too-old, unreachable-agent): its CAS
  // keeps the row `canceled` and settles the app to idle, and the follow-up logs run
  // ONLY when the outcome actually applied.
  if (running) {
    const applied = await commitOutcome(
      depId,
      target,
      { status: "ready", readyAt: nowIso(), buildDurationMs },
      {
        status: "active",
        ...(environment === "production" ? { productionUrl: url || null } : {}),
      },
    );
    if (applied) {
      log(
        depId,
        "success",
        url
          ? `Deployment ready at ${url}`
          : "Deployment ready (no domain - add one to route traffic)",
      );
      // Same post-success data-migration hook as the single-image path - production
      // only (a preview must not consume the marker or tear down the old host).
      if (environment === "production") {
        await completePendingAppMigration(project.id, (level, text) =>
          log(depId, level, text),
        ).catch((e) =>
          log(
            depId,
            "warn",
            `data migration step failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      await sweepAfterDeploy(depId, opts.serverId);
    }
  } else {
    if (
      await commitOutcome(
        depId,
        target,
        { status: "error", buildDurationMs },
        { status: "error" },
      )
    )
      log(depId, "error", "Stack did not reach a running state");
  }
}

/**
 * Deploy a multi-service compose stack via the owning server's agent (the host
 * running Deplo included).
 */
async function deployComposeStackViaAgent(
  opts: ComposeStackOpts & { serverId: string },
): Promise<void> {
  const { depId, project, deployKey, serverId } = opts;

  // A multi-service compose stack is a distinct source kind (SOURCE_KIND_COMPOSE).
  // Gate on the advertised capability instead and fail with an actionable message
  // (the operator must update the agent).
  try {
    const hello = await agentPreflight(serverId);
    if (!hello.capabilities.includes("deploy.compose.multi")) {
      log(
        depId,
        "error",
        "This server's agent is too old to run multi-service compose stacks. " +
          "Update the agent (reissue the install command from the server's actions menu).",
      );
      await finishComposeStack(opts, false);
      return;
    }
  } catch (e) {
    log(
      depId,
      "error",
      `Remote agent unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
    await finishComposeStack(opts, false);
    return;
  }

  const { stackYaml } = await prepareComposeStack(opts);
  const env = await appEnv(project.id, opts.environment, {
    preview: opts.preview,
  });

  const { outcome } = await tryAgent({
    depId,
    serverId,
    project: {
      id: project.id,
      deployKey,
      composeUpArgs: project.composeUpArgs ?? null,
    },
    // A compose stack has no single image_ref (each service brings its own); the
    // agent neither builds nor pulls one. Pass an empty ref.
    imageRef: "",
    composeYaml: stackYaml,
    env,
    plan: { kind: "compose", mounts: project.mounts ?? [] },
    // several images on the agent before any service reports running.
    readyTimeoutMs: 90_000,
    forceRecreate: opts.forceRecreate,
  });

  // tryAgent already logged the failure reason / unreachable-agent message.
  await finishComposeStack(opts, outcome === "agent");
}

/**
 * Hostnames to bake into a deploy's Traefik rule.
 */

/**
 * Which compose service a PREVIEW's router forwards to, and on which port. A
 * preview host is never a `domains` row, so it carries no service of its own, and
 * `buildComposeStack` skips every route that names none.
 */
async function previewRouteTarget(
  project: App,
  previewPort: number | null,
): Promise<{ service: string | null; port: number | null }> {
  if (!usesComposeStack(project)) return { service: null, port: previewPort };
  const primaryRow = await primaryDomainRow(project.id);
  if (primaryRow?.service) {
    return {
      service: primaryRow.service,
      port: previewPort ?? primaryRow.port ?? null,
    };
  }
  const detected = detectDefaultApp(project.compose ?? null);
  return {
    service: detected?.service ?? null,
    port: previewPort ?? detected?.port ?? null,
  };
}

async function routableForDeploy(
  appId: string,
  environment: DeploymentEnvironment,
  primary: string,
  /**
   * The preview host's certificate provider.
   */
  previewCertProvider?: CertProvider,
  /**
   * The compose SERVICE a preview's router forwards to, and the port to use.
   */
  previewTarget?: { service: string | null; port: number | null },
): Promise<RoutableDomain[]> {
  // A preview routes only to its own host.
  if (environment !== "production") {
    return [
      defaultRoute(
        primary,
        previewTarget?.service ?? null,
        previewTarget?.port ?? null,
        {
          certProvider: previewCertProvider ?? "none",
        },
      ),
    ];
  }
  const [valid, fallback] = await Promise.all([
    routableRoutes(appId),
    // The primary's STORED row, verified or not.
    pendingPrimaryRoute(appId, primary),
  ]);
  return orderDeployRoutes(valid, primary, fallback);
}

/**
 * Put the canonical primary host first and keep EVERY other routable row. The
 * fallback is only reached when nothing in `valid` is named `primary`, so it can
 * never duplicate a real row.
 */
export function orderDeployRoutes(
  valid: RoutableDomain[],
  primary: string,
  fallback?: RoutableDomain | null,
): RoutableDomain[] {
  const primaryFallback = () => fallback ?? defaultRoute(primary);
  if (valid.length === 0) return primary ? [primaryFallback()] : [];
  // The primary row keeps its own port override + TLS choice if it has one.
  const primaryRoute =
    valid.find((d) => d.name === primary) ?? primaryFallback();
  return [primaryRoute, ...valid.filter((d) => d !== primaryRoute)];
}

/** The `image:` baked into a single-image stack YAML, so a reroute reuses the
 * exact running image instead of rebuilding. Null if unreadable. The YAML is
 * read back from the OWNING agent's disk (conn.readStack), not a local file. */
function readStackImageFromYaml(
  stackYaml: string,
  service: string,
): string | null {
  try {
    const doc = yaml.load(stackYaml) as {
      services?: Record<string, { image?: unknown }>;
    } | null;
    const svc = doc?.services?.[service];
    return typeof svc?.image === "string" ? svc.image : null;
  } catch {
    return null;
  }
}

/** The `environment:` baked into a single-image stack YAML (map form, as
 * renderCompose writes it). Lets a reroute preserve the env the container is
 * actually running with instead of shipping pending edits from the store. */
function readStackEnvFromYaml(
  stackYaml: string,
  service: string,
): Record<string, string> | null {
  try {
    const doc = yaml.load(stackYaml) as {
      services?: Record<string, { environment?: unknown }>;
    } | null;
    const env = doc?.services?.[service]?.environment;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        out[k] = String(v);
      }
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The named volumes baked into a single-image stack file, read back so a reroute
 * preserves the mounts the container is ACTUALLY running with, never pulling a
 * pending (unsaved-to-stack) volume edit off the project.
 */
/** The shape `renderCompose` accepts and `parseStackVolumes` reconstructs. */
type StackVolume = {
  type?: "named" | "app" | "host";
  name: string;
  projectPath?: string;
  hostPath?: string;
  mountPath: string;
  readOnly?: boolean;
  propagation?: MountPropagation;
};

function readStackVolumesFromYaml(
  stackYaml: string,
  service: string,
): StackVolume[] {
  try {
    return parseStackVolumes(stackYaml, service);
  } catch {
    return [];
  }
}

/**
 * The health check the RUNNING stack carries, so a routing change keeps it rather
 * than quietly recreating the container without one. Read back like the image, the
 * env and the volumes, and for the same reason.
 */
export function parseStackHealthCheck(
  yamlText: string,
  service: string,
): Record<string, unknown> | null {
  try {
    const doc = yaml.load(yamlText) as {
      services?: Record<string, { healthcheck?: unknown }>;
    } | null;
    const hc = doc?.services?.[service]?.healthcheck;
    return hc && typeof hc === "object" && !Array.isArray(hc)
      ? (hc as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The pure parser behind `readStackVolumes` (no fs) - exported for tests.
 */
export function parseStackVolumes(
  yamlText: string,
  service: string,
): StackVolume[] {
  const doc = yaml.load(yamlText) as {
    services?: Record<string, { volumes?: unknown }>;
  } | null;
  const list = doc?.services?.[service]?.volumes;
  if (!Array.isArray(list)) return [];
  const filesRoot = join(STACK_DIR, "files") + "/";
  return list.flatMap((e) => {
    if (typeof e !== "string") return [];
    const [source, mountPath, flag] = e.split(":");
    if (!source || !mountPath) return [];
    // The option field is a COMMA LIST (`ro,rslave`), not a single word: reading
    // it as one dropped both flags off a bind that carried propagation, so a
    // reroute would have quietly re-rendered it read-write and rprivate.
    const opts = (flag ?? "").split(",");
    const readOnly = opts.includes("ro");
    const propagation = parseMountPropagation(opts);
    // Absent unless set, so an unchanged mount still deep-equals what it was.
    const prop = propagation ? { propagation } : {};
    if (source.startsWith(filesRoot)) {
      // `<filesRoot><slug>/<rel>` - drop the slug segment, the rest is the
      // project-relative path the "service" mount was authored with.
      const afterRoot = source.slice(filesRoot.length);
      const slash = afterRoot.indexOf("/");
      const projectPath = slash >= 0 ? afterRoot.slice(slash + 1) : "";
      if (projectPath) {
        return [
          { type: "app" as const, name: "", projectPath, mountPath, readOnly },
        ];
      }
    }
    if (source.startsWith("/")) {
      return [
        {
          type: "host" as const,
          name: "",
          hostPath: source,
          mountPath,
          readOnly,
          ...prop,
        },
      ];
    }
    return [{ name: source, mountPath, readOnly }];
  });
}

/**
 * Re-apply a project's Traefik routing to its already-running stack, instantly and
 * without rebuilding. Never starts a stopped (idle) project and never races a
 * deploy in progress (it re-renders the file but skips docker).
 */
export async function rerouteApp(
  appId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  const project = await loadAppGraph(appId);
  if (!project) return "deferred";
  // Reroute is PRODUCTION-only: it re-labels the App's own stack.
  const deployKey = project.slug;
  const name = stackName(deployKey);
  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return "deferred"; // no owning agent (server removed); nothing to do

  // Route exactly what a production DEPLOY would: every valid domain (primary first)
  // PLUS the pending primary as a fallback. Empty ⇒ the project has no domain at all
  // (never resurrected): nothing to write, leave it deferred.
  const primary = await primaryDomainName(appId);
  const routes = await routableForDeploy(appId, "production", primary);
  if (routes.length === 0) return "deferred"; // never write an empty Host() rule

  const hasCompose = Boolean(project.compose && project.compose.trim());
  const useCompose = usesComposeStack(project);

  const conn = await connectAgent(serverId);
  try {
    // Read the rendered stack back from the OWNING agent's disk. Never deployed
    // (or torn down) => nothing running to reroute; the domain change is saved and
    // the next deploy bakes the right labels.
    const current = await conn.readStack(deployKey);
    if (!current.exists) return "deferred";

    // Re-render the stack with the new domain set (so the labels are correct
    // whenever the stack next comes up), reusing the running image and env.
    let rendered: string;
    let mounts: { path: string; content: string }[] = [];
    if (useCompose && hasCompose) {
      rendered = buildComposeStack({
        compose: project.compose ?? "",
        name,
        deployKey,
        appId,
        // The `domains` table is the sole routing source: one router per routable
        // domain → its named compose service.
        domainRoutes: routes,
        filesDir: composeFilesDir(deployKey),
        basicAuthUsers: await basicAuthUsersValue(appId),
        // Inject the current settings env-var names so a reroute keeps the same
        // pass-throughs a deploy would render - the env-file (sent below) still carries the
        // values.
        envKeys: await appEnvKeys(appId),
        // The stack's volumes must be re-rendered too: omitting them here would make a
        // domain-only reroute silently UNMOUNT the app's storage (unlike the single-image
        // branch below, a compose stack is re-rendered from the app, not read back from the
        // running stack file).
        volumes: project.volumes,
      });
      mounts = (project.mounts ?? []).map((m) => ({
        path: m.filePath,
        content: m.content,
      }));
    } else {
      // Single-image / built path: the image ref and env live only in the stack
      // file (not on the project), so read them back from the agent's copy to keep
      // this a pure routing change, never a rebuild or a silent env/image change.
      const image = readStackImageFromYaml(current.yaml, name);
      if (!image) return "deferred"; // can't safely reroute without the running image
      const env =
        readStackEnvFromYaml(current.yaml, name) ?? (await appEnv(appId));
      // Volumes are read back from the stack (like image/env), NOT from
      // project.volumes, so a domain-only reroute keeps the running mounts and
      // never silently applies a volume edit the user hasn't redeployed.
      const volumes = readStackVolumesFromYaml(current.yaml, name);
      const basicAuthUsers = await basicAuthUsersValue(appId);
      rendered = renderCompose({
        name,
        image,
        port: project.build.port,
        appId,
        deployKey,
        routes,
        env,
        basicAuthUsers,
        // Mirror the deploy path: a prebuilt image never carries an injected PORT,
        // so a domain-only reroute must not add one (it would diverge from the
        // running stack and force a needless container restart).
        injectPort: project.source !== "docker-image",
        volumes,
        healthCheckKeys: parseStackHealthCheck(current.yaml, name),
      });
    }

    // No-op when the labels already match - avoids a pointless container restart
    // (e.g. re-verifying an already-valid domain, or toggling primary back).
    if (current.yaml === rendered) return "unchanged";

    // Only an active project may be recreated. Recreating an idle (deliberately
    // stopped) project would silently restart it; recreating mid-deploy races the
    // deploy on the same compose project.
    if (project.status !== "active") return "deferred";

    // For a single-image stack the env is baked into the YAML, so send no env-file
    // (mirrors the deploy path); compose stacks interpolate ${VAR} from the env.
    const env = useCompose && hasCompose ? await appEnv(appId) : {};
    // A reroute is a bring-up too, so the app's extra flags apply here as well,
    // otherwise "re-apply routing" would quietly run a different command than a
    // deploy does.
    const r = await conn.reroute({
      slug: deployKey,
      composeYaml: rendered,
      env,
      mounts,
      composeUpArgs: parseComposeUpArgs(project.composeUpArgs),
    });
    if (!r.ok) throw new Error(r.error || "agent failed to reroute the stack");
    return "rerouted";
  } finally {
    conn.close();
  }
}

/**
 * Render the full Deplo-generated stack for a project, for read-only display (the
 * "View full compose" button).
 */
export async function renderAppStack(appId: string): Promise<string | null> {
  const project = await loadAppGraph(appId);
  if (!project) return null;
  // The App's OWN stack - a pull request preview has no compose preview surface.
  const deployKey = project.slug;
  const name = stackName(deployKey);

  const hasCompose = Boolean(project.compose && project.compose.trim());
  if (usesComposeStack(project) && hasCompose) {
    // Mirror the deploy/reroute call exactly so the preview is byte-faithful to what
    // would be written.
    const routes = await routableRoutes(appId);
    const domainRoutes: RoutableDomain[] = routes.length
      ? routes
      : (await loadDomainsForApp(appId))
          .sort((a, b) => Number(b.primary) - Number(a.primary))
          .map((d) => defaultRoute(d.name, d.service ?? null, d.port ?? null));
    return buildComposeStack({
      compose: project.compose ?? "",
      name,
      deployKey,
      appId,
      domainRoutes,
      filesDir: composeFilesDir(deployKey),
      basicAuthUsers: await basicAuthUsersValue(appId),
      // Show the injected pass-throughs in the preview so "View full compose"
      // matches what the next deploy/reroute writes. Only NAMES appear - the
      // values never enter the rendered YAML (they ride the env-file).
      envKeys: await appEnvKeys(appId),
      // Include the per-app resource caps so the preview matches the next deploy.
      resources: project.resources,
      // Same for the Storage volumes and the top-level entries they add.
      volumes: project.volumes,
    });
  }

  // Single-image / built: the rendered stack only exists on the OWNING agent's
  // disk after a deploy. Read it back over the wire; null when never deployed or
  // the agent is unreachable (the preview just shows nothing yet).
  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return null;
  const conn = await connectAgent(serverId);
  try {
    const { exists, yaml: stackYaml } = await conn.readStack(deployKey);
    return exists ? stackYaml : null;
  } catch {
    return null;
  } finally {
    conn.close();
  }
}

/**
 * Stop a project's stack via the owning server's agent StopStack (PLAN Part C). An
 * unreachable agent throws (the caller surfaces it; a stop must not silently
 * no-op).
 */
export async function stopContainer(deployKey: string): Promise<void> {
  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return;
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.stopStack(deployKey);
    if (!r.ok) throw new Error(r.error || "agent failed to stop the stack");
  } finally {
    conn.close();
  }
}

/** Start a previously stopped stack via the owning agent's StartStack. */
export async function startContainer(deployKey: string): Promise<void> {
  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return;
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.startStack(deployKey);
    if (!r.ok) throw new Error(r.error || "agent failed to start the stack");
  } finally {
    conn.close();
  }
}

/**
 * Stop and remove a project's stack via the owning agent's DestroyStack.
 */
export async function destroyStack(
  deployKey: string,
  opts: { removeVolumes?: boolean } = {},
): Promise<void> {
  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return;
  const conn = await connectAgent(serverId);
  try {
    // `removeVolumes` is left UNSET for an App: its named volumes hold the user's data
    // and must survive a teardown they can undo.
    const r = await conn.destroyStack(deployKey, opts.removeVolumes);
    if (!r.ok) throw new Error(r.error || "agent failed to destroy the stack");
  } finally {
    conn.close();
  }
}
