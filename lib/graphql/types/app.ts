import { builder } from "../builder";
import { VarAuthorRef } from "./env";
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
  setAppBuildServer,
  clearAppBuildCache,
  updateAppSource,
  setAutoDeploy,
  renameApp,
  updateAppLogo,
  redetectAppLogo,
  stopApp,
  startApp,
  rebuildApp,
  startAppDelete,
  startAppsDelete,
  bulkAppAction,
  reorderApps,
  setAppVolumes,
  updateAppResources,
  findAppSummaryBySlugForTeam,
  summarizeForTeam,
  previewRepoFramework,
  setAppFramework,
  setAppComposeUpArgs,
  setAppRollbackKeep,
  type AppSummary,
  type ResourceLimitsInput,
} from "@/lib/data/apps";
import {
  revealDeployHook,
  rotateDeployHook,
  setDeployHookEnabled,
} from "@/lib/data/deploy-hook";
import {
  appTransferInfo,
  transferAppToTeam,
  type AppTransferInfo,
  type AppTransferTarget,
} from "@/lib/data/app-transfer";
import {
  effectiveFramework,
  frameworkById,
  type FrameworkDefinition,
} from "@/lib/apps/framework-catalog";
import { pubSub, APP_ACTIVITY_TOPIC } from "../pubsub";
import {
  listDeployments,
  getDeployment,
  getLogs,
  getQueuePosition,
  redeploy,
  rollbackDeployment,
  canRollbackTo,
  reloadApp as reapplyRouting,
  cancelDeployment,
  cancelAllDeployments,
  deleteDeployments,
  deleteAllDeployments,
  countActiveDeploymentsForTeam,
} from "@/lib/data/deployments";
import { renderAppStack } from "@/lib/deploy/build";
import { acceptDataCopyLoss } from "@/lib/data/data-copy";
import { redactComposeForDisplay } from "@/lib/deploy/compose-redact";
import { MOUNT_PROPAGATIONS } from "@/lib/types";
import type {
  BuildMethod,
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
  // `canRollback` rides along when the caller already computed it for a whole
  // list (listDeployments does it once for the app's history); the field below
  // falls back to the single-row read when it did not.
  .objectRef<Deployment & { canRollback?: boolean }>("Deployment")
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
      previewId: t.exposeID("previewId", {
        nullable: true,
        description:
          "The pull request preview this build belongs to, or null for production.",
      }),
      prNumber: t.exposeInt("prNumber", {
        nullable: true,
        description:
          "The pull request number, denormalized so it survives the preview " +
          "itself being reaped. Null for a production build.",
      }),
      deployKey: t.exposeString("deployKey", {
        description:
          "The stack this build owns: the app slug for production, " +
          "`<slug>__pr-<n>` for a pull request preview.",
      }),
      commitSha: t.exposeString("commitSha"),
      commitMessage: t.exposeString("commitMessage"),
      commitAuthor: t.exposeString("commitAuthor"),
      branch: t.exposeString("branch"),
      url: t.exposeString("url"),
      createdAt: t.exposeString("createdAt"),
      startedAt: t.exposeString("startedAt", {
        nullable: true,
        description:
          "When the build was claimed off the queue and started running — the " +
          "origin `buildDurationMs` is measured from, and what a live build " +
          "timer counts up from. Null while still queued.",
      }),
      readyAt: t.exposeString("readyAt", { nullable: true }),
      buildDurationMs: t.exposeInt("buildDurationMs", { nullable: true }),
      creator: t.exposeString("creator"),
      // Who `creator` names, when it names an account here. Null for a webhook
      // push (a GitHub login, not a deplo user) and for rows predating it — both
      // of which show the bare string with no picture.
      creatorUser: t.field({
        type: VarAuthorRef,
        nullable: true,
        resolve: (d) => d.creatorUser,
      }),
      rollbackOf: t.exposeID("rollbackOf", {
        nullable: true,
        description:
          "Set when this deploy was a rollback: the deployment whose image it " +
          "re-ran. Null when it built its own.",
      }),
      canRollback: t.field({
        type: "Boolean",
        description:
          "This app can be put back on this deployment: it succeeded, it built " +
          "an image, that image is still on the app's current server, and it is " +
          "not the one already running.",
        resolve: (d) =>
          d.canRollback !== undefined ? d.canRollback : canRollbackTo(d),
      }),
      logs: t.field({
        type: [LogLineRef],
        // A build log prints the app's build-time variables; `view_logs` is the
        // permission that names exactly this read (re-checked in `getLogs`).
        authScopes: { capability: "view_logs" },
        description: "Build logs for this deployment (most recent lines, capped).",
        // Cap the serialized payload so `apps { deployments { logs } }` can't
        // amplify into unbounded memory; the full stream is available live via
        // the SSE logs route.
        resolve: (d) => getLogs(d.id).then((lines) => lines.slice(-5000)),
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

const MountPropagationEnum = builder.enumType("MountPropagation", {
  description:
    "How mounts appearing UNDER a host bind mount cross between the server and " +
    "the container. Null is docker's `rprivate` default: the container sees only " +
    "the submounts that existed when it started, so a network disk, a FUSE share " +
    "or a volume another container mounts there never appears. `rslave` keeps " +
    "following the server; `rshared` is two-way. Host binds only — docker rejects " +
    "the option on a managed volume.",
  values: MOUNT_PROPAGATIONS,
});

const VolumeRef = builder.objectRef<VolumeMount>("Volume").implement({
  description:
    "A persistent volume mounted into an app — a docker named volume, an " +
    "app-files bind, or a host bind mount.",
  fields: (t) => ({
    id: t.exposeID("id"),
    // "named" (default), "app", or "host" — the UI re-derives its source
    // control from this, so it must round-trip back on read.
    type: t.string({ resolve: (v) => v.type ?? "named" }),
    name: t.exposeString("name"),
    projectPath: t.exposeString("projectPath", { nullable: true }),
    hostPath: t.exposeString("hostPath", { nullable: true }),
    // Compose stacks: the service this volume mounts into (null ⇒ the stack's
    // default service). Always null for a single-container app.
    service: t.string({ nullable: true, resolve: (v) => v.service ?? null }),
    mountPath: t.exposeString("mountPath"),
    readOnly: t.exposeBoolean("readOnly"),
    propagation: t.field({
      type: MountPropagationEnum,
      nullable: true,
      resolve: (v) => v.propagation ?? null,
    }),
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
      buildServerId: t.id({
        nullable: true,
        description:
          "The server that BUILDS this app's image, when that is not `serverId`. Null is Automatic: a build-only server if the fleet has one this team can reach and its architecture matches, otherwise build where the app runs. Setting it to `serverId` means 'always build on this app's own server'. Ignored by a compose stack and a docker-image source, neither of which Deplo builds.",
        resolve: (p) => p.buildServerId ?? null,
      }),
      buildFallbackLocal: t.boolean({
        description:
          "Build on this app's own server when the build server cannot be reached, saying so in the deploy log. True by default. False fails the deploy instead, for whoever chose a small deploy server on purpose.",
        resolve: (p) => p.buildFallbackLocal,
      }),
      logo: t.exposeString("logo", { nullable: true }),
      dataCopyError: t.exposeString("dataCopyError", {
        description:
          "Why this app's data did not arrive, when a migration tried to copy it and could not. Empty for every app that was never migrated and every copy that worked. While it is set, deploying and starting this app are refused - its volumes are empty or half written - and `deployWithoutMigratedData` is how someone accepts that and unblocks it.",
      }),
      framework: t.string({
        nullable: true,
        description:
          "The JavaScript framework backing this app " +
          '("nextjs", "astro", "nestjs", …), or null when none was found or the ' +
          "app doesn't build with one of the auto-detecting builders (Nixpacks / " +
          "Railpack). Detected on every deploy, unless setAppFramework has " +
          "corrected it — in which case that choice is what this returns.",
        resolve: (p) => effectiveFramework(p),
      }),
      frameworkDetected: t.exposeString("framework", {
        nullable: true,
        description:
          "What the LAST DEPLOY actually read from the source, ignoring any " +
          "correction. Equals `framework` unless the user overrode it.",
      }),
      source: t.field({ type: DeploySourceEnum, resolve: (p) => p.source }),
      dockerImage: t.exposeString("dockerImage", { nullable: true }),
      compose: t.exposeString("compose", { nullable: true }),
      volumes: t.field({
        type: [VolumeRef],
        description: "Persistent volumes mounted into this app.",
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
      deployHookEnabled: t.exposeBoolean("deployHookEnabled", {
        description:
          "Whether this app's deploy hook answers. The hook URL itself is never " +
          "a field — read it back with revealAppDeployHook.",
      }),
      composeUpArgs: t.exposeString("composeUpArgs", {
        nullable: true,
        description:
          "Extra flags this app appends to the `docker compose up` that brings " +
          "it up, or null for the untouched command. Additive only — the flags " +
          "that choose the project, stack file or env-file are refused.",
      }),
      rollbackKeep: t.exposeInt("rollbackKeep", {
        description:
          "How many previous deployments this app can be rolled back to (0-20, " +
          "default 3). Retention: its server keeps this many of the app's images " +
          "behind the running one. 0 means there is nothing to go back to.",
      }),
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
        description:
          "The app's most recent deployments, newest first (capped so a nested " +
          "query can't fan out over the whole history + per-deployment logs).",
        resolve: (p) => listDeployments({ appId: p.id, limit: 100 }),
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const GitRepoInput = builder.inputType("GitRepoInput", {
  fields: (t) => ({
    provider: t.string({
      required: true,
      description:
        "github | gitlab | bitbucket | gitea | git. Anything else is stored as git.",
    }),
    url: t.string({ required: true }),
    repo: t.string({ required: true }),
    branch: t.string({ required: true }),
    installationId: t.string({
      required: false,
      description: "A GitHub App installation that authenticates the clone.",
    }),
    connectionId: t.string({
      required: false,
      description:
        "A git connection (any other host) that authenticates the clone and carries the push webhook.",
    }),
    // Deploy options (see GitRepo). Absent ⇒ historical defaults (push / no
    // watch-path filter / no submodules).
    triggerType: t.string({ required: false, description: '"push" or "tag".' }),
    watchPaths: t.stringList({ required: false }),
    submodules: t.boolean({ required: false }),
  }),
});

/** The provider values that mean something to the deploy path; everything else
 *  is a plain git remote and is stored as one rather than trusted verbatim. */
const KNOWN_PROVIDERS = new Set<GitRepo["provider"]>([
  "github",
  "gitlab",
  "bitbucket",
  "gitea",
  "git",
]);

/** Coerce the untrusted GraphQL `provider` / `triggerType` strings to their unions. */
function repoInputToGitRepo(repo: {
  provider: string;
  url: string;
  repo: string;
  branch: string;
  installationId?: string | null;
  connectionId?: string | null;
  triggerType?: string | null;
  watchPaths?: (string | null)[] | null;
  submodules?: boolean | null;
}): GitRepo {
  const provider = repo.provider as GitRepo["provider"];
  return {
    provider: KNOWN_PROVIDERS.has(provider) ? provider : "git",
    url: repo.url,
    repo: repo.repo,
    branch: repo.branch,
    installationId: repo.installationId ?? undefined,
    connectionId: repo.connectionId ?? undefined,
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
    buildCache: t.boolean({
      required: false,
      description:
        "Reuse the owning server's Docker layer cache between builds of this " +
        "app (default true). False rebuilds every layer from scratch each time.",
    }),
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
  description: "A persistent volume mounted into an app.",
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
    /** Compose-stack apps: the service to mount into (blank ⇒ the stack's
     * default service). Ignored for single-container apps. */
    service: t.string({ required: false }),
    mountPath: t.string({ required: true }),
    readOnly: t.boolean({ required: false }),
    /** Host binds only: follow submounts that appear later. Null ⇒ docker's
     * `rprivate` default (a snapshot taken when the container started). */
    propagation: t.field({ type: MountPropagationEnum, required: false }),
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
    // Where the app is created (ADR-0009 — one home only): the folder, or the
    // project environment, the user had open on the Overview. Omitted ⇒ top
    // level. Authorized like a move into the same destination.
    folderId: t.string({ required: false }),
    projectId: t.string({ required: false }),
    environmentId: t.string({ required: false }),
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

const RecognizedFrameworkRef = builder
  .objectRef<FrameworkDefinition>("RecognizedFramework")
  .implement({
    description:
      "A JavaScript framework Deplo recognised in an app's source, with what it " +
      "knows about it. Detection only — Deplo never writes build commands from a " +
      "framework; the auto-detecting builders own that.",
    fields: (t) => ({
      id: t.exposeString("id", {
        description: 'Stable id, e.g. "nextjs" — also the key for its brand mark.',
      }),
      name: t.exposeString("name", {
        description: 'Display name, e.g. "Next.js".',
      }),
      defaultPort: t.exposeInt("defaultPort", {
        description:
          "The port this framework's production server binds when nothing tells " +
          "it otherwise — what a new app's container port defaults to.",
      }),
    }),
  });

const AppTransferTargetRef = builder
  .objectRef<AppTransferTarget>("AppTransferTarget")
  .implement({
    description:
      "A team the viewer could hand this app to — one of their OWN other teams " +
      "where they hold the deploy capability.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      serverAvailable: t.exposeBoolean("serverAvailable", {
        description:
          "False when the app's server is restricted and not shared with that " +
          "team — the transfer is refused until an instance admin grants access.",
      }),
      githubFollows: t.exposeBoolean("githubFollows", {
        description:
          "True when the repository connection survives the move, because that " +
          "team has its own GitHub App installed on the repository's account. " +
          "False ⇒ the connection and auto-deploy are dropped and must be " +
          "reconnected there. Always true when the app has no GitHub connection.",
      }),
    }),
  });

const AppTransferInfoRef = builder
  .objectRef<AppTransferInfo>("AppTransferInfo")
  .implement({
    description:
      "What a transfer of this app would cost, plus the teams that could take it.",
    fields: (t) => ({
      appName: t.exposeString("appName"),
      serverName: t.exposeString("serverName"),
      homeLabel: t.exposeString("homeLabel", {
        nullable: true,
        description:
          'Where the app currently sits in its team ("folder Marketing"), or ' +
          "null at the top level. It leaves that home on transfer.",
      }),
      sharedVarCount: t.exposeInt("sharedVarCount", {
        description:
          "Shared variables linked to this app. The links do not survive the " +
          "move (the variables belong to the current team).",
      }),
      backupCount: t.exposeInt("backupCount", {
        description:
          "Backup schedules targeting this app — removed on transfer, because " +
          "they point at the current team's backup destination.",
      }),
      githubConnected: t.exposeBoolean("githubConnected"),
      gitConnectionLabel: t.exposeString("gitConnectionLabel", {
        nullable: true,
        description:
          "The git connection authenticating this app's clone, or null. It is " +
          "always dropped on transfer — a token is owned by the current team " +
          "and cannot be assumed to reach the repository from another one.",
      }),
      targets: t.field({
        type: [AppTransferTargetRef],
        resolve: (x) => x.targets,
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  appTransferInfo: t.field({
    type: AppTransferInfoRef,
    authScopes: { capability: "move_apps" },
    description:
      "What transferring this app to another team would change, and which of " +
      "the viewer's other teams could take it.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => appTransferInfo(appId),
  }),
  apps: t.field({
    type: [AppRef],
    authScopes: { loggedIn: true },
    description: "All apps in the active team, newest first.",
    args: {
      q: t.arg.string({
        required: false,
        description:
          "Keep only the apps whose name, slug or id contains this, ignoring " +
          "case and separators. Use `search` to look across teams.",
      }),
    },
    resolve: (_r, { q }) => listApps(q ?? undefined),
  }),
  app: t.field({
    type: AppRef,
    nullable: true,
    authScopes: { loggedIn: true },
    args: { slug: t.arg.string({ required: true }) },
    resolve: (_r, { slug }) => getAppBySlug(slug),
  }),
  detectRepoFramework: t.field({
    type: RecognizedFrameworkRef,
    nullable: true,
    authScopes: { capability: "create_apps" },
    description:
      "Recognise the JavaScript framework in a GitHub repository before an app " +
      "exists for it — what the new-app wizard shows while you pick a repo. " +
      "Null when there is nothing to recognise: a build method other than " +
      "Nixpacks / Railpack (the only ones this applies to), a repository Deplo " +
      "can't read, or a repository with no framework in it. Reads only; the " +
      "app's first deploy re-derives and stores the answer.",
    args: {
      repo: t.arg.string({
        required: true,
        description: 'The repository as "owner/name".',
      }),
      url: t.arg.string({
        required: false,
        description: "Its clone URL, when the caller has one (else derived).",
      }),
      branch: t.arg.string({
        required: false,
        description: "Branch to read; empty ⇒ the repository's default branch.",
      }),
      installationId: t.arg.string({
        required: false,
        description:
          "GitHub App installation to read a private repo through. Ignored " +
          "unless it belongs to the active team.",
      }),
      buildMethod: t.arg.string({
        required: true,
        description: 'The build method the app will use, e.g. "nixpacks".',
      }),
      rootDirectory: t.arg.string({
        required: false,
        description: "Build sub-directory, for a monorepo.",
      }),
    },
    resolve: async (_r, args) =>
      frameworkById(
        await previewRepoFramework({
          repo: args.repo,
          url: args.url,
          branch: args.branch,
          installationId: args.installationId,
          // Untrusted string: anything that isn't a real method simply fails the
          // Nixpacks/Railpack test inside and yields null.
          buildMethod: args.buildMethod as BuildMethod,
          rootDirectory: args.rootDirectory,
        }),
      ),
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

/** What a folder's or a project's ⋯ menu can run over all of its apps at once.
 *  Redeploy is its own mutation: it is a different permission (`deploy_apps`). */
const BulkAppActionEnum = builder.enumType("BulkAppAction", {
  description:
    "A lifecycle action run over every app in a folder or project: start, " +
    "stop, or restart (stop then start).",
  values: ["start", "stop", "restart"] as const,
});

const BulkAppActionResultRef = builder
  .objectRef<{ ok: number; failed: number; error: string | null }>(
    "BulkAppActionResult",
  )
  .implement({
    description:
      "The outcome of a bulk action: how many apps it ran on, how many " +
      "refused or failed, and the first failure's message. Apps the caller " +
      "can't reach are not counted at all.",
    fields: (t) => ({
      ok: t.exposeInt("ok"),
      failed: t.exposeInt("failed"),
      error: t.exposeString("error", { nullable: true }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Mutations (every app/deployment server action)                  */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createApp: t.field({
    type: AppRef,
    authScopes: { capability: "create_apps" },
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
        folderId: input.folderId ?? null,
        projectId: input.projectId ?? null,
        environmentId: input.environmentId ?? null,
      }),
  }),
  renameApp: t.field({
    type: AppRef,
    authScopes: { capability: "configure_apps" },
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
    // data layer re-checks the same gate (defense-in-depth): `move_apps` moves
    // ONE app between containers, it does not define the team's grid order.
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
    authScopes: { capability: "configure_apps" },
    args: {
      id: t.arg.string({ required: true }),
      build: t.arg({ type: BuildConfigInput, required: true }),
    },
    resolve: async (_r, { id, build }) => {
      await updateAppBuild(id, remapBuildInput(build) as never);
      return reloadApp(id);
    },
  }),
  setAppBuildServer: t.field({
    type: AppRef,
    authScopes: { capability: "configure_apps" },
    description:
      "Choose which server BUILDS this app. Null buildServerId is Automatic (a build-only server if the fleet has one this team can reach and its architecture matches, otherwise build where the app runs); passing the app's own server id means 'always build here'. buildFallbackLocal decides what happens when the build server is unreachable: build on the app's own server (the default) or fail the deploy. Changing either never starts a deploy.",
    args: {
      id: t.arg.string({ required: true }),
      buildServerId: t.arg.string({ required: false }),
      buildFallbackLocal: t.arg.boolean({ required: false }),
    },
    resolve: async (_r, { id, buildServerId, buildFallbackLocal }) => {
      await setAppBuildServer(id, {
        buildServerId: buildServerId ?? null,
        buildFallbackLocal: buildFallbackLocal ?? undefined,
      });
      return reloadApp(id);
    },
  }),
  setAppFramework: t.field({
    type: AppRef,
    authScopes: { capability: "configure_apps" },
    description:
      "Correct the framework Deplo recognised in this app's source (a catalog " +
      "id such as \"vite\"), or pass null to go back to trusting detection. The " +
      "correction survives every later deploy's re-detection.",
    args: {
      id: t.arg.string({ required: true }),
      framework: t.arg.string({ required: false }),
    },
    resolve: async (_r, { id, framework }) => {
      await setAppFramework(id, framework ?? null);
      return reloadApp(id);
    },
  }),
  updateAppResources: t.field({
    type: AppRef,
    description:
      "Save the app's per-app resource caps (RAM/CPU/PIDs/disk/…). Applied on " +
      "the next deploy. A cleared field ⇒ that dimension is uncapped.",
    authScopes: { capability: "configure_apps" },
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
    authScopes: { capability: "configure_apps" },
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
    authScopes: { capability: "configure_apps" },
    description:
      "Replace an app's volumes (named, app-files, and host bind mounts). Compose-stack apps included — each volume names the service it mounts into.",
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
              : // "service" is the wire spelling the volume editor has always
                // sent for a files-dir bind; "app" is the domain-object one.
                v.type === "app" || v.type === "service"
                ? ("app" as const)
                : ("named" as const),
          name: v.name ?? "",
          projectPath: v.projectPath ?? undefined,
          hostPath: v.hostPath ?? undefined,
          service: v.service ?? undefined,
          mountPath: v.mountPath,
          readOnly: v.readOnly ?? false,
          propagation: v.propagation ?? undefined,
        })),
      );
      return reloadApp(id);
    },
  }),
  setAppAutoDeploy: t.field({
    type: AppRef,
    authScopes: { capability: "configure_apps" },
    args: {
      id: t.arg.string({ required: true }),
      value: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { id, value }) => {
      await setAutoDeploy(id, value);
      return reloadApp(id);
    },
  }),
  setAppComposeUpArgs: t.field({
    type: AppRef,
    authScopes: { capability: "configure_apps" },
    description:
      "Set (or clear, with null) the extra flags appended to this app's " +
      "`docker compose up`. Rejects anything that isn't a plain flag, and any " +
      "flag that would choose the project, stack file or env-file.",
    args: {
      id: t.arg.string({ required: true }),
      value: t.arg.string({ required: false }),
    },
    resolve: async (_r, { id, value }) => {
      await setAppComposeUpArgs(id, value ?? null);
      return reloadApp(id);
    },
  }),
  setAppDeployHookEnabled: t.field({
    type: AppRef,
    authScopes: { capability: "configure_apps" },
    description:
      "Turn this app's deploy hook on or off. Off ⇒ the endpoint refuses every " +
      "call, whatever URL or API token it carries.",
    args: {
      id: t.arg.string({ required: true }),
      value: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { id, value }) => {
      await setDeployHookEnabled(id, value);
      return reloadApp(id);
    },
  }),
  revealAppDeployHook: t.field({
    type: "String",
    authScopes: { capability: "configure_apps" },
    description:
      "The app's full deploy hook URL, minting it on first read. Calling it " +
      "still requires an API token as `Authorization: Bearer deplo_…`.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => revealDeployHook(id),
  }),
  rotateAppDeployHook: t.field({
    type: "String",
    authScopes: { capability: "configure_apps" },
    description:
      "Mint a new deploy hook URL for the app and return it. Every copy of the " +
      "previous URL stops working immediately.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => rotateDeployHook(id),
  }),
  updateAppLogo: t.field({
    type: AppRef,
    authScopes: { capability: "configure_apps" },
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
    authScopes: { capability: "configure_apps" },
    description:
      "Auto-detect a favicon from the app's own files — its GitHub repo, its uploaded archive, or (for a compose stack) its files dir on its server — and set it as the logo. Errors if none is found.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await redetectAppLogo(id);
      return reloadApp(id);
    },
  }),
  stopApp: t.field({
    type: AppRef,
    authScopes: { capability: "control_apps" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await stopApp(id);
      return reloadApp(id);
    },
  }),
  startApp: t.field({
    type: AppRef,
    authScopes: { capability: "control_apps" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await startApp(id);
      return reloadApp(id);
    },
  }),
  rebuildApp: t.field({
    type: AppRef,
    description:
      "Rebuild the image from the current source and REPLACE the running " +
      "container, even if nothing about the stack changed. Volumes, domains " +
      "and data are untouched.",
    authScopes: { capability: "deploy_apps" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await rebuildApp(id);
      return reloadApp(id);
    },
  }),
  clearAppBuildCache: t.field({
    type: AppRef,
    description:
      "Clear this app's build cache: the next deployment builds from scratch " +
      "instead of reusing cached layers, then caches again. Nothing is pruned " +
      "on the server — the build cache is shared by every app on it.",
    authScopes: { capability: "configure_apps" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await clearAppBuildCache(id);
      return reloadApp(id);
    },
  }),
  reloadApp: t.field({
    type: "String",
    authScopes: { capability: "control_apps" },
    description:
      "Re-apply the app's routing (domains + basic auth) to the running stack without a rebuild. Returns 'rerouted', 'unchanged', or 'deferred'.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => reapplyRouting(id),
  }),
  transferAppToTeam: t.field({
    type: "Boolean",
    // `deploy` is the introspectable floor; the data layer additionally demands
    // `manage_env` here (the app carries its encrypted variables across a
    // tenancy boundary) and `deploy` in the DESTINATION team.
    authScopes: { capability: "move_apps" },
    description:
      "Hand this app over to another team the viewer belongs to. The app keeps " +
      "running: it leaves its folder/project, loses its shared-variable links " +
      "and backup schedules, and keeps its GitHub connection only if the " +
      "destination team has its own installation on that account. Returns true.",
    args: {
      appId: t.arg.string({ required: true }),
      teamId: t.arg.string({ required: true }),
    },
    resolve: async (_r, { appId, teamId }) => {
      await transferAppToTeam(appId, teamId);
      return true;
    },
  }),
  deleteApp: t.field({
    type: "Boolean",
    authScopes: { capability: "delete_apps" },
    description:
      "Delete the app. Returns as soon as the deletion is RECORDED — from that " +
      "moment the app is refused by every gate and gone from the product — and " +
      "the stack teardown finishes on the host behind the response.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await startAppDelete(id);
      return true;
    },
  }),
  deleteApps: t.field({
    type: "Int",
    authScopes: { capability: "delete_apps" },
    description:
      "Bulk-delete several apps. Returns how many were recorded as deleted; the " +
      "bounded-concurrency teardown runs behind the response.",
    args: { ids: t.arg.idList({ required: true }) },
    resolve: (_r, { ids }) => startAppsDelete(ids.map(String)),
  }),
  bulkAppAction: t.field({
    type: BulkAppActionResultRef,
    authScopes: { capability: "control_apps" },
    description:
      "Start, stop or restart EVERY app in one folder (its whole subtree) or " +
      "one project (every environment). Gated again per app, so it only " +
      "touches the ones the caller may control; one failure never stops the " +
      "rest. Give exactly one of folderId / projectId.",
    args: {
      action: t.arg({ type: BulkAppActionEnum, required: true }),
      folderId: t.arg.id({ required: false }),
      projectId: t.arg.id({ required: false }),
    },
    resolve: (_r, { action, folderId, projectId }) =>
      bulkAppAction(action, {
        folderId: folderId ? String(folderId) : null,
        projectId: projectId ? String(projectId) : null,
      }),
  }),
  bulkRedeployApps: t.field({
    type: BulkAppActionResultRef,
    authScopes: { capability: "deploy_apps" },
    description:
      "Redeploy EVERY app in one folder (its whole subtree) or one project " +
      "(every environment): the bulk twin of `redeploy`. Give exactly one " +
      "of folderId / projectId.",
    args: {
      folderId: t.arg.id({ required: false }),
      projectId: t.arg.id({ required: false }),
    },
    resolve: (_r, { folderId, projectId }) =>
      bulkAppAction("redeploy", {
        folderId: folderId ? String(folderId) : null,
        projectId: projectId ? String(projectId) : null,
      }),
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
      // (single-image stacks inline the resolved plaintext) AND the basic-auth
      // htpasswd label, which rides a Traefik label rather than `environment:`
      // and so was readable by anyone who could open the app at all.
      return yaml === null ? null : redactComposeForDisplay(yaml);
    },
  }),
  deployWithoutMigratedData: t.field({
    type: AppRef,
    authScopes: { capability: "deploy_apps" },
    description:
      "Accept that the data a migration could not copy is not coming, and let " +
      "this app deploy again: clears `dataCopyError`. The way out for an app " +
      "whose source machine has since been turned off, which is how a migration " +
      "normally ends. Recorded in Activity.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await acceptDataCopyLoss({ kind: "app", id });
      return reloadApp(id);
    },
  }),
  redeploy: t.field({
    type: DeploymentRef,
    authScopes: { capability: "deploy_apps" },
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => redeploy(appId),
  }),
  rollbackDeployment: t.field({
    type: DeploymentRef,
    authScopes: { capability: "rollback_apps" },
    description:
      "Put an app back on a previous deployment by re-running the image that " +
      "build left on the server - no clone, no rebuild, no pull. Only a " +
      "successful production deployment of an app Deplo builds (a repository or " +
      "an uploaded archive), still inside the app's rollback retention and on " +
      "the app's current server, can be rolled back to; ask for `canRollback` " +
      "on the deployment to know. The code goes back and NOTHING ELSE does: the " +
      "stack is rendered from the app's current variables, domains, volumes and " +
      "resource limits. Returns the new deployment.",
    args: { deploymentId: t.arg.string({ required: true }) },
    resolve: (_r, { deploymentId }) => rollbackDeployment(deploymentId),
  }),
  setAppRollbackKeep: t.field({
    type: AppRef,
    // `configure_apps`, not `rollback_apps`: how many rollbacks an app keeps is
    // how much disk its images hold on the server, which is a setting, not the
    // act of going back. See the note on the data-layer function.
    authScopes: { capability: "configure_apps" },
    description:
      "How many previous deployments this app can be rolled back to (0-20, " +
      "default 3). It is retention: the app's server keeps this many of its " +
      "images behind the running one. Takes effect on the next sweep - lowering " +
      "it removes nothing now, and raising it cannot bring back images already " +
      "removed.",
    args: {
      id: t.arg.string({ required: true }),
      count: t.arg.int({ required: true }),
    },
    resolve: async (_r, { id, count }) => {
      await setAppRollbackKeep(id, count);
      return reloadApp(id);
    },
  }),
  cancelDeployment: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy_apps" },
    args: { id: t.arg.string({ required: true }) },
    // Returns false if the deployment had already finished (nothing to stop).
    resolve: (_r, { id }) => cancelDeployment(id),
  }),
  cancelAllDeployments: t.field({
    type: "Int",
    authScopes: { capability: "deploy_apps" },
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
  deleteDeployments: t.field({
    type: "Int",
    authScopes: { capability: "delete_apps" },
    description:
      "Delete finished deployments (ready/error/canceled) by id; in-progress ones (queued/building) are left to be canceled first. Returns how many were deleted.",
    args: { ids: t.arg.idList({ required: true }) },
    resolve: (_r, { ids }) => deleteDeployments(ids.map(String)),
  }),
  deleteAllDeployments: t.field({
    type: "Int",
    authScopes: { capability: "delete_apps" },
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
    // stream; the generator enforces team ownership AND per-app access below.
    authScopes: { loggedIn: true },
    args: { slug: t.arg.string({ required: true }) },
    subscribe: (_root, { slug }, ctx) =>
      appStatusStream(slug, ctx.teamId, ctx.viewer?.id ?? null),
    // The generator yields fully-resolved, team-scoped snapshots already.
    resolve: (project) => project,
  }),
  activeDeployments: t.int({
    description:
      "Emits how many deployments are in flight (queued or building) across the active team, counting only the apps the caller can reach. Fires once immediately, then on every change - it is what the sidebar's live chip reads.",
    authScopes: { loggedIn: true },
    subscribe: (_root, _args, ctx) =>
      activeDeploymentsStream(ctx.teamId, ctx.viewer?.id ?? null),
    resolve: (count) => count,
  }),
}));

/**
 * Live count of the team's in-flight builds. Cookie-free like the stream above:
 * team and principal come from the GraphQL context, and the count re-reads
 * through the explicit-argument seam on every ping.
 *
 * It listens on the instance-wide `appActivity` channel because a team-wide
 * feed has no per-resource key to filter on. Every app change wakes it; only a
 * CHANGED count is pushed, so a start/stop that moves nothing emits nothing.
 */
export async function* activeDeploymentsStream(
  teamId: string | null,
  userId: string | null,
): AsyncGenerator<number> {
  if (!teamId || !userId) throw new Error("Not signed in");
  let last = await countActiveDeploymentsForTeam(teamId, userId);
  yield last;
  for await (const changedId of pubSub.subscribe(
    "appActivity",
    APP_ACTIVITY_TOPIC,
  )) {
    // The payload names the app that moved; this answer is a team-wide count,
    // so the id means nothing here beyond "re-read".
    void changedId;
    const next = await countActiveDeploymentsForTeam(teamId, userId);
    if (next === last) continue;
    last = next;
    yield next;
  }
}

// Exported for the cut-set (c) SSE test (PLAN §6 "Add a test that drives the
// generator across >1 ping"): it must stay cookie-free across iteration ticks.
export async function* appStatusStream(
  slug: string,
  teamId: string | null,
  userId: string | null,
): AsyncGenerator<AppSummary> {
  if (!teamId || !userId) throw new Error("App not found");
  // Cookie-free (PLAN §6): both lookups take the explicit `teamId` + `userId`
  // and query Postgres directly — they never call a cookie-reading helper, so
  // they remain callable across the async-iteration ticks of this long-lived SSE
  // response. They also answer the per-app access question, so an app inside a
  // folder this member can't see is "not found" here exactly as it is on its own
  // page — a live status feed must not be the way around folder privacy.
  const project = await findAppSummaryBySlugForTeam(slug, teamId, userId);
  if (!project) throw new Error("App not found");
  const appId = project.id;

  // Initial snapshot — a fresh subscriber paints current state immediately.
  yield project;

  // Forward each change ping as a freshly-reloaded snapshot. The payload is the
  // changed app's id (always this app's, given the keyed channel). If the app was
  // deleted — or moved somewhere this member can no longer reach — mid-stream,
  // summarizeForTeam returns null → end.
  for await (const changedId of pubSub.subscribe("appChanged", appId)) {
    const next = await summarizeForTeam(changedId, teamId, userId);
    if (!next) return;
    yield next;
  }
}
