import { builder } from "../builder";
import { remapBuildInput } from "./build-input";
import { ResourceLimitsRef, ResourceLimitsInputType } from "./resource-limits";
import {
  DeploySourceEnum,
  DeploymentStatusEnum,
  DeploymentEnvironmentEnum,
  AppStatusEnum,
} from "./enums";
import {
  listApps,
  getAppBySlug,
  getAppById,
  createApp,
  updateAppBuild,
  updateAppSource,
  setAutoDeploy,
  renameApp,
  updateAppLogo,
  redetectAppLogo,
  stopApp,
  startApp,
  rebuildApp,
  deleteApp,
  deleteApps,
  reorderApps,
  setAppVolumes,
  updateAppResources,
  findAppSummaryBySlugForTeam,
  summarizeForTeam,
  type AppSummary,
  type ResourceLimitsInput,
} from "@/lib/data/apps";
import { pubSub } from "../pubsub";
import {
  listDeployments,
  getDeployment,
  getLogs,
  getQueuePosition,
  redeploy,
  reloadApp as reapplyRouting,
  cancelDeployment,
  cancelAllDeployments,
  deleteDeployments,
  deleteAllDeployments,
  promoteToProduction,
} from "@/lib/data/deployments";
import { renderAppStack } from "@/lib/deploy/build";
import type {
  Deployment,
  GitRepo,
  LogLine,
  VolumeMount,
} from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const LogLineRef = builder.objectRef<LogLine>("LogLine").implement({
  fields: (t) => ({
    ts: t.exposeString("ts"),
    level: t.exposeString("level"),
    text: t.exposeString("text"),
  }),
});

export const DeploymentRef = builder
  .objectRef<Deployment>("Deployment")
  .implement({
    description: "A single build + release of an app.",
    fields: (t) => ({
      id: t.exposeID("id"),
      appId: t.exposeID("appId"),
      status: t.field({ type: DeploymentStatusEnum, resolve: (d) => d.status }),
      environment: t.field({
        type: DeploymentEnvironmentEnum,
        resolve: (d) => d.environment,
      }),
      commitSha: t.exposeString("commitSha"),
      commitMessage: t.exposeString("commitMessage"),
      commitAuthor: t.exposeString("commitAuthor"),
      branch: t.exposeString("branch"),
      url: t.exposeString("url"),
      createdAt: t.exposeString("createdAt"),
      readyAt: t.exposeString("readyAt", { nullable: true }),
      buildDurationMs: t.exposeInt("buildDurationMs", { nullable: true }),
      creator: t.exposeString("creator"),
      logs: t.field({
        type: [LogLineRef],
        description: "Build logs for this deployment.",
        resolve: (d) => getLogs(d.id),
      }),
      queuePosition: t.field({
        type: "Int",
        nullable: true,
        description:
          "1-based position in the owning server's build queue while this " +
          "deployment is `queued` (1 = next to build); null once it starts " +
          "building or finishes.",
        resolve: (d) => getQueuePosition(d.id),
      }),
    }),
  });

const VolumeRef = builder.objectRef<VolumeMount>("Volume").implement({
  description:
    "A persistent volume mounted into a single-container project — a docker " +
    "named volume, an app-files bind, or a host bind mount.",
  fields: (t) => ({
    id: t.exposeID("id"),
    // "named" (default), "app", or "host" — the UI re-derives its source
    // control from this, so it must round-trip back on read.
    type: t.string({ resolve: (v) => v.type ?? "named" }),
    name: t.exposeString("name"),
    projectPath: t.exposeString("projectPath", { nullable: true }),
    hostPath: t.exposeString("hostPath", { nullable: true }),
    mountPath: t.exposeString("mountPath"),
    readOnly: t.exposeBoolean("readOnly"),
  }),
});

export const AppRef = builder
  .objectRef<AppSummary>("App")
  .implement({
    description: "A deployable application owned by a team.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
      teamId: t.exposeID("teamId"),
      folderId: t.exposeID("folderId", { nullable: true }),
      projectId: t.field({
        type: "ID",
        nullable: true,
        description: "The Project container this app belongs to, if any.",
        resolve: (p) => p.projectId ?? null,
      }),
      serverId: t.exposeID("serverId"),
      logo: t.exposeString("logo", { nullable: true }),
      source: t.field({ type: DeploySourceEnum, resolve: (p) => p.source }),
      dockerImage: t.exposeString("dockerImage", { nullable: true }),
      compose: t.exposeString("compose", { nullable: true }),
      volumes: t.field({
        type: [VolumeRef],
        description:
          "Persistent named volumes (single-container apps only).",
        resolve: (p) => p.volumes ?? [],
      }),
      resources: t.field({
        type: ResourceLimitsRef,
        nullable: true,
        description:
          "Per-app resource caps applied at deploy time, or null when the app " +
          "has no limits set.",
        resolve: (p) => p.resources,
      }),
      productionUrl: t.exposeString("productionUrl", { nullable: true }),
      status: t.field({ type: AppStatusEnum, resolve: (p) => p.status }),
      autoDeploy: t.exposeBoolean("autoDeploy"),
      domainCount: t.exposeInt("domainCount"),
      createdAt: t.exposeString("createdAt"),
      updatedAt: t.exposeString("updatedAt"),
      latestDeployment: t.field({
        type: DeploymentRef,
        nullable: true,
        resolve: (p) => p.latestDeployment,
      }),
      deployments: t.field({
        type: [DeploymentRef],
        description: "All deployments of this app, newest first.",
        resolve: (p) => listDeployments({ appId: p.id }),
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const GitRepoInput = builder.inputType("GitRepoInput", {
  fields: (t) => ({
    provider: t.string({ required: true }),
    url: t.string({ required: true }),
    repo: t.string({ required: true }),
    branch: t.string({ required: true }),
    installationId: t.string({ required: false }),
    // Deploy options (see GitRepo). Absent ⇒ historical defaults (push / no
    // watch-path filter / no submodules).
    triggerType: t.string({ required: false, description: '"push" or "tag".' }),
    watchPaths: t.stringList({ required: false }),
    submodules: t.boolean({ required: false }),
  }),
});

/** Coerce an untrusted GraphQL `triggerType` string to the GitTriggerType union. */
function repoInputToGitRepo(repo: {
  provider: string;
  url: string;
  repo: string;
  branch: string;
  installationId?: string | null;
  triggerType?: string | null;
  watchPaths?: (string | null)[] | null;
  submodules?: boolean | null;
}): GitRepo {
  return {
    provider: repo.provider as GitRepo["provider"],
    url: repo.url,
    repo: repo.repo,
    branch: repo.branch,
    installationId: repo.installationId ?? undefined,
    triggerType: repo.triggerType === "tag" ? "tag" : "push",
    watchPaths: (repo.watchPaths ?? [])
      .filter((p): p is string => !!p)
      .map((p) => p.trim())
      .filter(Boolean),
    submodules: repo.submodules ?? false,
  };
}

const BuildConfigInput = builder.inputType("BuildConfigInput", {
  description:
    "Partial build configuration; only the provided fields are changed.",
  fields: (t) => ({
    buildMethod: t.string({ required: false }),
    rootDir: t.string({ required: false }),
    // Same names as BuildConfig, so remapBuildInput forwards them untouched.
    includeFilesOutsideRoot: t.boolean({ required: false }),
    skipUnchangedDeployments: t.boolean({ required: false }),
    installCommand: t.string({ required: false }),
    buildCommand: t.string({ required: false }),
    outputDir: t.string({ required: false }),
    startCommand: t.string({ required: false }),
    runtimeVersion: t.string({ required: false }),
    port: t.int({ required: false }),
    settings: t.field({ type: "JSON", required: false }),
  }),
});

const ExtraDomainInput = builder.inputType("ExtraDomainInput", {
  description:
    "A multi-domain template's extra (non-primary) routed host: the compose " +
    "service + port it targets and its hostname. Registered as an auto Domain " +
    "row at creation; the `domains` table is the sole routing source after.",
  fields: (t) => ({
    service: t.string({ required: true }),
    port: t.int({ required: true }),
    host: t.string({ required: true }),
  }),
});

const AppEnvInput = builder.inputType("AppEnvInput", {
  description: "An initial environment variable for a new app.",
  fields: (t) => ({
    key: t.string({ required: true }),
    value: t.string({ required: true }),
  }),
});

const MountInput = builder.inputType("MountInput", {
  description: "A config file a template materialises into its stack at deploy.",
  fields: (t) => ({
    filePath: t.string({ required: true }),
    content: t.string({ required: true }),
  }),
});

const VolumeInput = builder.inputType("VolumeInput", {
  description: "A persistent volume for a single-container project.",
  fields: (t) => ({
    id: t.string({ required: false }),
    /** "named" (docker-managed, default), "app" (bind inside the app's
     * files dir), or "host" (bind an absolute host path). */
    type: t.string({ required: false }),
    name: t.string({ required: false }),
    /** Path relative to the app's files dir (project mounts only). */
    projectPath: t.string({ required: false }),
    /** Absolute host path to bind-mount (host mounts only). */
    hostPath: t.string({ required: false }),
    mountPath: t.string({ required: true }),
    readOnly: t.boolean({ required: false }),
  }),
});

const CreateAppInputType = builder.inputType("CreateAppInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    source: t.field({ type: DeploySourceEnum, required: true }),
    repo: t.field({ type: GitRepoInput, required: false }),
    dockerImage: t.string({ required: false }),
    logo: t.string({ required: false }),
    compose: t.string({ required: false }),
    serverId: t.string({ required: false }),
    build: t.field({ type: BuildConfigInput, required: false }),
    autoDeploy: t.boolean({ required: false }),
    // Template/compose deploys carry these so a one-click template keeps its
    // env, routing, baked domain and config-file mounts (audit-restored: these
    // were silently dropped in the first rewiring pass).
    env: t.field({ type: [AppEnvInput], required: false }),
    composeService: t.string({ required: false }),
    composePort: t.int({ required: false }),
    extraDomains: t.field({ type: [ExtraDomainInput], required: false }),
    autoDomain: t.string({ required: false }),
    mounts: t.field({ type: [MountInput], required: false }),
  }),
});

const UpdateSourceInputType = builder.inputType("UpdateSourceInput", {
  fields: (t) => ({
    source: t.field({ type: DeploySourceEnum, required: true }),
    repo: t.field({ type: GitRepoInput, required: false }),
    dockerImage: t.string({ required: false }),
    serverId: t.string({ required: false }),
    compose: t.string({ required: false }),
    // Routing (the Traefik domains) lives in the `domains` table, managed via the
    // Domains tab — not threaded through the deploy-source edit.
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  apps: t.field({
    type: [AppRef],
    authScopes: { loggedIn: true },
    description: "All apps in the active team, newest first.",
    resolve: () => listApps(),
  }),
  app: t.field({
    type: AppRef,
    nullable: true,
    authScopes: { loggedIn: true },
    args: { slug: t.arg.string({ required: true }) },
    resolve: (_r, { slug }) => getAppBySlug(slug),
  }),
  deployments: t.field({
    type: [DeploymentRef],
    authScopes: { loggedIn: true },
    args: {
      appId: t.arg.string({ required: false }),
      environment: t.arg({ type: DeploymentEnvironmentEnum, required: false }),
      status: t.arg({ type: DeploymentStatusEnum, required: false }),
    },
    resolve: (_r, args) =>
      listDeployments({
        appId: args.appId ?? undefined,
        environment: args.environment ?? undefined,
        status: args.status ?? undefined,
      }),
  }),
  deployment: t.field({
    type: DeploymentRef,
    nullable: true,
    authScopes: { loggedIn: true },
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getDeployment(id),
  }),
}));

/**
 * Redact every value under an `environment:` block of a rendered stack. The
 * single-image stack file inlines the RESOLVED env values (app secrets, linked
 * shared vars, instance globals) in plaintext, and the preview is served at the
 * `view` floor — the values must never reach the client (secrets are write-only,
 * no reveal path). Variables stay listed by NAME so the preview still shows what
 * the deploy injects. Compose stacks already carry names only (bare `- KEY`
 * pass-throughs; values ride the env-file), so their lines pass through
 * unchanged.
 */
function redactComposeEnvValues(yaml: string): string {
  const MASKED = "••••••••";
  let envIndent: number | null = null;
  return yaml
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;
      if (envIndent !== null) {
        if (trimmed !== "" && indent <= envIndent) {
          envIndent = null; // left the environment: block
        } else if (trimmed !== "") {
          // Map form (`KEY: value`) and list form (`- KEY=value`) both hide
          // the value; a bare `- KEY` pass-through has none to hide.
          const map = /^(\s+[^\s:]+:)\s+\S.*$/.exec(line);
          if (map) return `${map[1]} ${JSON.stringify(MASKED)}`;
          const list = /^(\s+-\s+)(["']?)([^=\s"']+)=.*$/.exec(line);
          if (list) return `${list[1]}${list[3]}=${MASKED}`;
          return line;
        }
      }
      if (envIndent === null && trimmed === "environment:") envIndent = indent;
      return line;
    })
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Mutations (every app/deployment server action)                  */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createApp: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    args: { input: t.arg({ type: CreateAppInputType, required: true }) },
    resolve: (_r, { input }) =>
      createApp({
        name: input.name,
        source: input.source,
        repo: input.repo ? repoInputToGitRepo(input.repo) : null,
        dockerImage: input.dockerImage ?? null,
        logo: input.logo ?? null,
        compose: input.compose ?? null,
        serverId: input.serverId ?? undefined,
        // Remap the input's `settings` to the stored `methodSettings` shape so
        // method settings chosen at create time aren't silently dropped (see
        // updateAppBuild). buildConfigFor reads overrides.methodSettings.
        build: input.build ? (remapBuildInput(input.build) as never) : undefined,
        autoDeploy: input.autoDeploy ?? undefined,
        env: input.env?.map((e) => ({ key: e.key, value: e.value })),
        composeService: input.composeService ?? null,
        composePort: input.composePort ?? null,
        extraDomains: input.extraDomains
          ? input.extraDomains.map((e) => ({
              service: e.service,
              port: e.port,
              host: e.host,
            }))
          : null,
        autoDomain: input.autoDomain ?? null,
        mounts: input.mounts
          ? input.mounts.map((m) => ({ filePath: m.filePath, content: m.content }))
          : null,
      }),
  }),
  renameApp: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, name }) => {
      await renameApp(id, name);
      return reloadApp(id);
    },
  }),
  reorderApps: t.field({
    type: "Boolean",
    // Team-wide setting: an instance admin OR a member with manage_team. The
    // data layer re-checks the same gate (defense-in-depth).
    authScopes: { $any: { instanceAdmin: true, capability: "manage_team" } },
    description: "Set the team-wide display order of apps in Overview.",
    args: { appIds: t.arg.idList({ required: true }) },
    resolve: async (_r, { appIds }) => {
      await reorderApps(appIds.map(String));
      return true;
    },
  }),
  updateAppBuild: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      build: t.arg({ type: BuildConfigInput, required: true }),
    },
    resolve: async (_r, { id, build }) => {
      await updateAppBuild(id, remapBuildInput(build) as never);
      return reloadApp(id);
    },
  }),
  updateAppResources: t.field({
    type: AppRef,
    description:
      "Save the app's per-app resource caps (RAM/CPU/PIDs/disk/…). Applied on " +
      "the next deploy. A cleared field ⇒ that dimension is uncapped.",
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      limits: t.arg({ type: ResourceLimitsInputType, required: true }),
    },
    resolve: async (_r, { id, limits }) => {
      await updateAppResources(id, limits as ResourceLimitsInput);
      return reloadApp(id);
    },
  }),
  updateAppSource: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: UpdateSourceInputType, required: true }),
    },
    resolve: async (_r, { id, input }) => {
      await updateAppSource(id, {
        source: input.source,
        repo: input.repo ? repoInputToGitRepo(input.repo) : null,
        dockerImage: input.dockerImage ?? null,
        serverId: input.serverId ?? undefined,
        compose: input.compose ?? undefined,
      });
      return reloadApp(id);
    },
  }),
  setAppVolumes: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    description:
      "Replace a single-container app's volumes (named, app-files, and host bind mounts).",
    args: {
      id: t.arg.string({ required: true }),
      volumes: t.arg({ type: [VolumeInput], required: true }),
    },
    resolve: async (_r, { id, volumes }) => {
      await setAppVolumes(
        id,
        volumes.map((v) => ({
          id: v.id ?? "",
          type:
            v.type === "host"
              ? ("host" as const)
              : v.type === "app"
                ? ("app" as const)
                : ("named" as const),
          name: v.name ?? "",
          projectPath: v.projectPath ?? undefined,
          hostPath: v.hostPath ?? undefined,
          mountPath: v.mountPath,
          readOnly: v.readOnly ?? false,
        })),
      );
      return reloadApp(id);
    },
  }),
  setAppAutoDeploy: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      value: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { id, value }) => {
      await setAutoDeploy(id, value);
      return reloadApp(id);
    },
  }),
  updateAppLogo: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      logo: t.arg.string({ required: false }),
    },
    resolve: async (_r, { id, logo }) => {
      await updateAppLogo(id, logo ?? null);
      return reloadApp(id);
    },
  }),
  detectAppLogo: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    description:
      "Auto-detect a favicon (SVG/PNG) from the app's GitHub repo or uploaded files and set it as the logo. Errors if none is found.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await redetectAppLogo(id);
      return reloadApp(id);
    },
  }),
  stopApp: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await stopApp(id);
      return reloadApp(id);
    },
  }),
  startApp: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await startApp(id);
      return reloadApp(id);
    },
  }),
  rebuildApp: t.field({
    type: AppRef,
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await rebuildApp(id);
      return reloadApp(id);
    },
  }),
  reloadApp: t.field({
    type: "String",
    authScopes: { capability: "deploy" },
    description:
      "Re-apply the app's routing (domains + basic auth) to the running stack without a rebuild. Returns 'rerouted', 'unchanged', or 'deferred'.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => reapplyRouting(id),
  }),
  deleteApp: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy" },
    description: "Delete the app and tear down its stack. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteApp(id);
      return true;
    },
  }),
  deleteApps: t.field({
    type: "Int",
    authScopes: { capability: "deploy" },
    description:
      "Bulk-delete several apps (bounded-concurrency teardown + one write). Returns how many were deleted.",
    args: { ids: t.arg.idList({ required: true }) },
    resolve: (_r, { ids }) => deleteApps(ids.map(String)),
  }),
  renderComposeStack: t.field({
    type: "String",
    nullable: true,
    authScopes: { loggedIn: true },
    description: "Render the docker-compose stack an app would deploy.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      // Team-scope the request before rendering (the render fn is unscoped).
      const project = await getAppById(appId);
      if (!project) throw new Error("App not found");
      const yaml = await renderAppStack(project.id);
      // The preview is served at the `view` floor: mask every env VALUE
      // (single-image stacks inline the resolved plaintext) before it leaves.
      return yaml === null ? null : redactComposeEnvValues(yaml);
    },
  }),
  redeploy: t.field({
    type: DeploymentRef,
    authScopes: { capability: "deploy" },
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => redeploy(appId),
  }),
  cancelDeployment: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    // Returns false if the deployment had already finished (nothing to stop).
    resolve: (_r, { id }) => cancelDeployment(id),
  }),
  cancelAllDeployments: t.field({
    type: "Int",
    authScopes: { capability: "deploy" },
    description:
      "Cancel every in-progress deployment (queued/building) for one app (appId given) or across the whole active team (appId omitted), optionally narrowed to the deployments view filters: one owning server (serverId), one environment, and/or one status. Terminal deployments are left. Returns how many builds were stopped.",
    args: {
      appId: t.arg.id({ required: false }),
      serverId: t.arg.id({ required: false }),
      environment: t.arg.string({ required: false }),
      status: t.arg.string({ required: false }),
    },
    resolve: (_r, { appId, serverId, environment, status }) =>
      cancelAllDeployments(
        appId != null ? String(appId) : null,
        serverId != null ? String(serverId) : null,
        environment != null ? String(environment) : null,
        status != null ? String(status) : null,
      ),
  }),
  promoteDeployment: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy" },
    description: "Promote a preview deployment to production.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await promoteToProduction(id);
      return true;
    },
  }),
  deleteDeployments: t.field({
    type: "Int",
    authScopes: { capability: "deploy" },
    description:
      "Delete finished deployments (ready/error/canceled) by id; in-progress ones (queued/building) are left to be canceled first. Returns how many were deleted.",
    args: { ids: t.arg.idList({ required: true }) },
    resolve: (_r, { ids }) => deleteDeployments(ids.map(String)),
  }),
  deleteAllDeployments: t.field({
    type: "Int",
    authScopes: { capability: "deploy" },
    description:
      "Delete every finished deployment for one app (appId given) or across the whole active team (appId omitted), optionally narrowed to the deployments view filters: one owning server (serverId), one environment, and/or one status. In-progress deployments are left. Returns how many were deleted.",
    args: {
      appId: t.arg.id({ required: false }),
      serverId: t.arg.id({ required: false }),
      environment: t.arg.string({ required: false }),
      status: t.arg.string({ required: false }),
    },
    resolve: (_r, { appId, serverId, environment, status }) =>
      deleteAllDeployments(
        appId != null ? String(appId) : null,
        serverId != null ? String(serverId) : null,
        environment != null ? String(environment) : null,
        status != null ? String(status) : null,
      ),
  }),
}));

/** Reload an app by id after a void mutation so we can return the entity. */
async function reloadApp(id: string): Promise<AppSummary> {
  const all = await listApps();
  const found = all.find((p) => p.id === id);
  if (!found) throw new Error("App not found");
  return found;
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */

/**
 * Live project status, served over SSE on the same `/api/graphql` endpoint
 * (Yoga negotiates `text/event-stream` for subscriptions — no separate
 * WebSocket server). Pushes a fresh project snapshot whenever the app's
 * power/deploy state changes, so the dashboard reflects start/stop/deploy
 * without a reload and stays in sync across every connected client.
 *
 * Lives here (not a separate module) so the only edge to `AppRef` and the
 * data layer stays within this file — a cross-module import of `AppRef`
 * created a second evaluation path to this module under Turbopack and tripped a
 * duplicate-type registration.
 *
 * IMPORTANT — no cookies in the stream. A subscription's async iterator runs
 * AFTER the HTTP handler returns the streaming Response, so Next's `cookies()`
 * is no longer callable. The caller's team is resolved from the GraphQL context
 * (`ctx.teamId`, established in request scope by buildContext); every lookup in
 * the generator uses the cookie-free `*ForTeam` data seams.
 */
builder.subscriptionType({});

builder.subscriptionFields((t) => ({
  appStatus: t.field({
    type: AppRef,
    description:
      "Emits the app whenever its status (power / deployment) changes. " +
      "Fires once immediately with the current snapshot, then on every change.",
    // `loggedIn` (synchronous `!!ctx.viewer` — no cookie call) gates opening the
    // stream; the generator enforces team ownership of the app below.
    authScopes: { loggedIn: true },
    args: { slug: t.arg.string({ required: true }) },
    subscribe: (_root, { slug }, ctx) => appStatusStream(slug, ctx.teamId),
    // The generator yields fully-resolved, team-scoped snapshots already.
    resolve: (project) => project,
  }),
}));

// Exported for the cut-set (c) SSE test (PLAN §6 "Add a test that drives the
// generator across >1 ping"): it must stay cookie-free across iteration ticks.
export async function* appStatusStream(
  slug: string,
  teamId: string | null,
): AsyncGenerator<AppSummary> {
  if (!teamId) throw new Error("App not found");
  // Cookie-free (PLAN §6): both lookups take the explicit `teamId` and query
  // Postgres directly — they never call a cookie-reading helper, so they remain
  // callable across the async-iteration ticks of this long-lived SSE response.
  const project = await findAppSummaryBySlugForTeam(slug, teamId);
  if (!project) throw new Error("App not found");
  const appId = project.id;

  // Initial snapshot — a fresh subscriber paints current state immediately.
  yield project;

  // Forward each change ping as a freshly-reloaded snapshot. The payload is the
  // changed app's id (always this app's, given the keyed channel). If
  // the app was deleted mid-stream, summarizeForTeam returns null → end.
  for await (const changedId of pubSub.subscribe("appChanged", appId)) {
    const next = await summarizeForTeam(changedId, teamId);
    if (!next) return;
    yield next;
  }
}
