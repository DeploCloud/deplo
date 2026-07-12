import { builder } from "../builder";
import { remapBuildInput } from "./build-input";
import {
  DeploySourceEnum,
  DeploymentStatusEnum,
  DeploymentEnvironmentEnum,
  ServiceStatusEnum,
} from "./enums";
import {
  listServices,
  getServiceBySlug,
  getServiceById,
  createService,
  updateServiceBuild,
  updateServiceSource,
  setAutoDeploy,
  renameService,
  updateServiceLogo,
  redetectServiceLogo,
  stopService,
  startService,
  rebuildService,
  deleteService,
  deleteServices,
  reorderServices,
  setServiceVolumes,
  findServiceSummaryBySlugForTeam,
  summarizeForTeam,
  type ServiceSummary,
} from "@/lib/data/services";
import { pubSub } from "../pubsub";
import {
  listDeployments,
  getDeployment,
  getLogs,
  redeploy,
  reloadService as reapplyRouting,
  cancelDeployment,
  cancelAllDeployments,
  deleteDeployments,
  deleteAllDeployments,
  promoteToProduction,
} from "@/lib/data/deployments";
import { renderServiceStack } from "@/lib/deploy/build";
import type { Deployment, GitRepo, LogLine, VolumeMount } from "@/lib/types";

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
    description: "A single build + release of a service.",
    fields: (t) => ({
      id: t.exposeID("id"),
      serviceId: t.exposeID("serviceId"),
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
    }),
  });

const VolumeRef = builder.objectRef<VolumeMount>("Volume").implement({
  description:
    "A persistent volume mounted into a single-container project — a docker " +
    "named volume, a service-files bind, or a host bind mount.",
  fields: (t) => ({
    id: t.exposeID("id"),
    // "named" (default), "service", or "host" — the UI re-derives its source
    // control from this, so it must round-trip back on read.
    type: t.string({ resolve: (v) => v.type ?? "named" }),
    name: t.exposeString("name"),
    projectPath: t.exposeString("projectPath", { nullable: true }),
    hostPath: t.exposeString("hostPath", { nullable: true }),
    mountPath: t.exposeString("mountPath"),
    readOnly: t.exposeBoolean("readOnly"),
  }),
});

export const ServiceRef = builder
  .objectRef<ServiceSummary>("Service")
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
        description: "The Project container this service belongs to, if any.",
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
          "Persistent named volumes (single-container services only).",
        resolve: (p) => p.volumes ?? [],
      }),
      productionUrl: t.exposeString("productionUrl", { nullable: true }),
      status: t.field({ type: ServiceStatusEnum, resolve: (p) => p.status }),
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
        description: "All deployments of this service, newest first.",
        resolve: (p) => listDeployments({ serviceId: p.id }),
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

const ServiceEnvInput = builder.inputType("ServiceEnvInput", {
  description: "An initial environment variable for a new service.",
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
    /** "named" (docker-managed, default), "service" (bind inside the service's
     * files dir), or "host" (bind an absolute host path). */
    type: t.string({ required: false }),
    name: t.string({ required: false }),
    /** Path relative to the service's files dir (project mounts only). */
    projectPath: t.string({ required: false }),
    /** Absolute host path to bind-mount (host mounts only). */
    hostPath: t.string({ required: false }),
    mountPath: t.string({ required: true }),
    readOnly: t.boolean({ required: false }),
  }),
});

const CreateServiceInputType = builder.inputType("CreateServiceInput", {
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
    env: t.field({ type: [ServiceEnvInput], required: false }),
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
  services: t.field({
    type: [ServiceRef],
    authScopes: { loggedIn: true },
    description: "All services in the active team, newest first.",
    resolve: () => listServices(),
  }),
  service: t.field({
    type: ServiceRef,
    nullable: true,
    authScopes: { loggedIn: true },
    args: { slug: t.arg.string({ required: true }) },
    resolve: (_r, { slug }) => getServiceBySlug(slug),
  }),
  deployments: t.field({
    type: [DeploymentRef],
    authScopes: { loggedIn: true },
    args: {
      serviceId: t.arg.string({ required: false }),
      environment: t.arg({ type: DeploymentEnvironmentEnum, required: false }),
      status: t.arg({ type: DeploymentStatusEnum, required: false }),
    },
    resolve: (_r, args) =>
      listDeployments({
        serviceId: args.serviceId ?? undefined,
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

/* ------------------------------------------------------------------ */
/* Mutations (every service/deployment server action)                  */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createService: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    args: { input: t.arg({ type: CreateServiceInputType, required: true }) },
    resolve: (_r, { input }) =>
      createService({
        name: input.name,
        source: input.source,
        repo: input.repo ? repoInputToGitRepo(input.repo) : null,
        dockerImage: input.dockerImage ?? null,
        logo: input.logo ?? null,
        compose: input.compose ?? null,
        serverId: input.serverId ?? undefined,
        // Remap the input's `settings` to the stored `methodSettings` shape so
        // method settings chosen at create time aren't silently dropped (see
        // updateServiceBuild). buildConfigFor reads overrides.methodSettings.
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
  renameService: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, name }) => {
      await renameService(id, name);
      return reloadService(id);
    },
  }),
  reorderServices: t.field({
    type: "Boolean",
    // Team-wide setting: an instance admin OR a member with manage_team. The
    // data layer re-checks the same gate (defense-in-depth).
    authScopes: { $any: { instanceAdmin: true, capability: "manage_team" } },
    description: "Set the team-wide display order of services in Overview.",
    args: { serviceIds: t.arg.idList({ required: true }) },
    resolve: async (_r, { serviceIds }) => {
      await reorderServices(serviceIds.map(String));
      return true;
    },
  }),
  updateServiceBuild: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      build: t.arg({ type: BuildConfigInput, required: true }),
    },
    resolve: async (_r, { id, build }) => {
      await updateServiceBuild(id, remapBuildInput(build) as never);
      return reloadService(id);
    },
  }),
  updateServiceSource: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: UpdateSourceInputType, required: true }),
    },
    resolve: async (_r, { id, input }) => {
      await updateServiceSource(id, {
        source: input.source,
        repo: input.repo ? repoInputToGitRepo(input.repo) : null,
        dockerImage: input.dockerImage ?? null,
        serverId: input.serverId ?? undefined,
        compose: input.compose ?? undefined,
      });
      return reloadService(id);
    },
  }),
  setServiceVolumes: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    description:
      "Replace a single-container service's volumes (named, service-files, and host bind mounts).",
    args: {
      id: t.arg.string({ required: true }),
      volumes: t.arg({ type: [VolumeInput], required: true }),
    },
    resolve: async (_r, { id, volumes }) => {
      await setServiceVolumes(
        id,
        volumes.map((v) => ({
          id: v.id ?? "",
          type:
            v.type === "host"
              ? ("host" as const)
              : v.type === "service"
                ? ("service" as const)
                : ("named" as const),
          name: v.name ?? "",
          projectPath: v.projectPath ?? undefined,
          hostPath: v.hostPath ?? undefined,
          mountPath: v.mountPath,
          readOnly: v.readOnly ?? false,
        })),
      );
      return reloadService(id);
    },
  }),
  setServiceAutoDeploy: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      value: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { id, value }) => {
      await setAutoDeploy(id, value);
      return reloadService(id);
    },
  }),
  updateServiceLogo: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      logo: t.arg.string({ required: false }),
    },
    resolve: async (_r, { id, logo }) => {
      await updateServiceLogo(id, logo ?? null);
      return reloadService(id);
    },
  }),
  detectServiceLogo: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    description:
      "Auto-detect a favicon (SVG/PNG) from the service's GitHub repo or uploaded files and set it as the logo. Errors if none is found.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await redetectServiceLogo(id);
      return reloadService(id);
    },
  }),
  stopService: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await stopService(id);
      return reloadService(id);
    },
  }),
  startService: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await startService(id);
      return reloadService(id);
    },
  }),
  rebuildService: t.field({
    type: ServiceRef,
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await rebuildService(id);
      return reloadService(id);
    },
  }),
  reloadService: t.field({
    type: "String",
    authScopes: { capability: "deploy" },
    description:
      "Re-apply the service's routing (domains + basic auth) to the running stack without a rebuild. Returns 'rerouted', 'unchanged', or 'deferred'.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => reapplyRouting(id),
  }),
  deleteService: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy" },
    description: "Delete the service and tear down its stack. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteService(id);
      return true;
    },
  }),
  deleteServices: t.field({
    type: "Int",
    authScopes: { capability: "deploy" },
    description:
      "Bulk-delete several services (bounded-concurrency teardown + one write). Returns how many were deleted.",
    args: { ids: t.arg.idList({ required: true }) },
    resolve: (_r, { ids }) => deleteServices(ids.map(String)),
  }),
  renderComposeStack: t.field({
    type: "String",
    nullable: true,
    authScopes: { loggedIn: true },
    description: "Render the docker-compose stack a service would deploy.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: async (_r, { serviceId }) => {
      // Team-scope the request before rendering (the render fn is unscoped).
      const project = await getServiceById(serviceId);
      if (!project) throw new Error("Service not found");
      return renderServiceStack(project.id);
    },
  }),
  redeploy: t.field({
    type: DeploymentRef,
    authScopes: { capability: "deploy" },
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: (_r, { serviceId }) => redeploy(serviceId),
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
      "Cancel every in-progress deployment (queued/building) for one service (serviceId given) or across the whole active team (serviceId omitted), optionally narrowed to one owning server (serverId). Terminal deployments are left. Returns how many builds were stopped.",
    args: {
      serviceId: t.arg.id({ required: false }),
      serverId: t.arg.id({ required: false }),
    },
    resolve: (_r, { serviceId, serverId }) =>
      cancelAllDeployments(
        serviceId != null ? String(serviceId) : null,
        serverId != null ? String(serverId) : null,
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
      "Delete every finished deployment for one service (serviceId given) or across the whole active team (serviceId omitted), optionally narrowed to one owning server (serverId). In-progress deployments are left. Returns how many were deleted.",
    args: {
      serviceId: t.arg.id({ required: false }),
      serverId: t.arg.id({ required: false }),
    },
    resolve: (_r, { serviceId, serverId }) =>
      deleteAllDeployments(
        serviceId != null ? String(serviceId) : null,
        serverId != null ? String(serverId) : null,
      ),
  }),
}));

/** Reload a service by id after a void mutation so we can return the entity. */
async function reloadService(id: string): Promise<ServiceSummary> {
  const all = await listServices();
  const found = all.find((p) => p.id === id);
  if (!found) throw new Error("Service not found");
  return found;
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */

/**
 * Live project status, served over SSE on the same `/api/graphql` endpoint
 * (Yoga negotiates `text/event-stream` for subscriptions — no separate
 * WebSocket server). Pushes a fresh project snapshot whenever the service's
 * power/deploy state changes, so the dashboard reflects start/stop/deploy
 * without a reload and stays in sync across every connected client.
 *
 * Lives here (not a separate module) so the only edge to `ServiceRef` and the
 * data layer stays within this file — a cross-module import of `ServiceRef`
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
  serviceStatus: t.field({
    type: ServiceRef,
    description:
      "Emits the service whenever its status (power / deployment) changes. " +
      "Fires once immediately with the current snapshot, then on every change.",
    // `loggedIn` (synchronous `!!ctx.viewer` — no cookie call) gates opening the
    // stream; the generator enforces team ownership of the service below.
    authScopes: { loggedIn: true },
    args: { slug: t.arg.string({ required: true }) },
    subscribe: (_root, { slug }, ctx) => serviceStatusStream(slug, ctx.teamId),
    // The generator yields fully-resolved, team-scoped snapshots already.
    resolve: (project) => project,
  }),
}));

// Exported for the cut-set (c) SSE test (PLAN §6 "Add a test that drives the
// generator across >1 ping"): it must stay cookie-free across iteration ticks.
export async function* serviceStatusStream(
  slug: string,
  teamId: string | null,
): AsyncGenerator<ServiceSummary> {
  if (!teamId) throw new Error("Service not found");
  // Cookie-free (PLAN §6): both lookups take the explicit `teamId` and query
  // Postgres directly — they never call a cookie-reading helper, so they remain
  // callable across the async-iteration ticks of this long-lived SSE response.
  const project = await findServiceSummaryBySlugForTeam(slug, teamId);
  if (!project) throw new Error("Service not found");
  const serviceId = project.id;

  // Initial snapshot — a fresh subscriber paints current state immediately.
  yield project;

  // Forward each change ping as a freshly-reloaded snapshot. The payload is the
  // changed service's id (always this service's, given the keyed channel). If
  // the service was deleted mid-stream, summarizeForTeam returns null → end.
  for await (const changedId of pubSub.subscribe("serviceChanged", serviceId)) {
    const next = await summarizeForTeam(changedId, teamId);
    if (!next) return;
    yield next;
  }
}
