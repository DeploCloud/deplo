import { builder } from "../builder";
import {
  DeploySourceEnum,
  DeploymentStatusEnum,
  DeploymentEnvironmentEnum,
  ProjectStatusEnum,
} from "./enums";
import {
  listProjects,
  getProjectBySlug,
  getProjectById,
  createProject,
  updateProjectBuild,
  updateProjectSource,
  setAutoDeploy,
  renameProject,
  updateProjectLogo,
  stopProject,
  startProject,
  rebuildProject,
  deleteProject,
  setProjectVolumes,
  type ProjectSummary,
} from "@/lib/data/projects";
import {
  listDeployments,
  getDeployment,
  getLogs,
  redeploy,
  cancelDeployment,
  promoteToProduction,
} from "@/lib/data/deployments";
import { renderProjectStack } from "@/lib/deploy/build";
import type { Deployment, LogLine, VolumeMount } from "@/lib/types";

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
    description: "A single build + release of a project.",
    fields: (t) => ({
      id: t.exposeID("id"),
      projectId: t.exposeID("projectId"),
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
    "A persistent docker named volume mounted into a single-container project.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    mountPath: t.exposeString("mountPath"),
    readOnly: t.exposeBoolean("readOnly"),
  }),
});

export const ProjectRef = builder
  .objectRef<ProjectSummary>("Project")
  .implement({
    description: "A deployable application owned by a team.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
      teamId: t.exposeID("teamId"),
      serverId: t.exposeID("serverId"),
      framework: t.exposeString("framework"),
      logo: t.exposeString("logo", { nullable: true }),
      source: t.field({ type: DeploySourceEnum, resolve: (p) => p.source }),
      dockerImage: t.exposeString("dockerImage", { nullable: true }),
      compose: t.exposeString("compose", { nullable: true }),
      volumes: t.field({
        type: [VolumeRef],
        description:
          "Persistent named volumes (single-container projects only).",
        resolve: (p) => p.volumes ?? [],
      }),
      productionUrl: t.exposeString("productionUrl", { nullable: true }),
      status: t.field({ type: ProjectStatusEnum, resolve: (p) => p.status }),
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
        description: "All deployments of this project, newest first.",
        resolve: (p) => listDeployments({ projectId: p.id }),
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
  }),
});

const BuildConfigInput = builder.inputType("BuildConfigInput", {
  description:
    "Partial build configuration; only the provided fields are changed.",
  fields: (t) => ({
    framework: t.string({ required: false }),
    buildMethod: t.string({ required: false }),
    rootDir: t.string({ required: false }),
    installCommand: t.string({ required: false }),
    buildCommand: t.string({ required: false }),
    outputDir: t.string({ required: false }),
    startCommand: t.string({ required: false }),
    runtimeVersion: t.string({ required: false }),
    port: t.int({ required: false }),
    settings: t.field({ type: "JSON", required: false }),
  }),
});

const ExposeInput = builder.inputType("ExposeInput", {
  description: "Which compose service + port Traefik exposes.",
  fields: (t) => ({
    service: t.string({ required: true }),
    port: t.int({ required: true }),
    host: t.string({ required: false }),
  }),
});

const ProjectEnvInput = builder.inputType("ProjectEnvInput", {
  description: "An initial environment variable for a new project.",
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
    /** "named" (docker-managed, default) or "host" (bind a host path). */
    type: t.string({ required: false }),
    name: t.string({ required: false }),
    /** Absolute host path to bind-mount (host mounts only). */
    hostPath: t.string({ required: false }),
    mountPath: t.string({ required: true }),
    readOnly: t.boolean({ required: false }),
  }),
});

const CreateProjectInputType = builder.inputType("CreateProjectInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    framework: t.string({ required: true }),
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
    env: t.field({ type: [ProjectEnvInput], required: false }),
    composeService: t.string({ required: false }),
    composePort: t.int({ required: false }),
    exposes: t.field({ type: [ExposeInput], required: false }),
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
    // The compose-stack routing the old action carried as composeService/
    // composePort/exposes — needed so a compose/template deploy keeps routing.
    expose: t.field({ type: ExposeInput, required: false }),
    exposes: t.field({ type: [ExposeInput], required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  projects: t.field({
    type: [ProjectRef],
    authScopes: { loggedIn: true },
    description: "All projects in the active team, newest first.",
    resolve: () => listProjects(),
  }),
  project: t.field({
    type: ProjectRef,
    nullable: true,
    authScopes: { loggedIn: true },
    args: { slug: t.arg.string({ required: true }) },
    resolve: (_r, { slug }) => getProjectBySlug(slug),
  }),
  deployments: t.field({
    type: [DeploymentRef],
    authScopes: { loggedIn: true },
    args: {
      projectId: t.arg.string({ required: false }),
      environment: t.arg({ type: DeploymentEnvironmentEnum, required: false }),
      status: t.arg({ type: DeploymentStatusEnum, required: false }),
    },
    resolve: (_r, args) =>
      listDeployments({
        projectId: args.projectId ?? undefined,
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
/* Mutations (every project/deployment server action)                  */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createProject: t.field({
    type: ProjectRef,
    authScopes: { capability: "deploy" },
    args: { input: t.arg({ type: CreateProjectInputType, required: true }) },
    resolve: (_r, { input }) =>
      createProject({
        name: input.name,
        framework: input.framework as never,
        source: input.source,
        repo: input.repo
          ? {
              provider: input.repo.provider as never,
              url: input.repo.url,
              repo: input.repo.repo,
              branch: input.repo.branch,
              installationId: input.repo.installationId ?? undefined,
            }
          : null,
        dockerImage: input.dockerImage ?? null,
        logo: input.logo ?? null,
        compose: input.compose ?? null,
        serverId: input.serverId ?? undefined,
        build: (input.build ?? undefined) as never,
        autoDeploy: input.autoDeploy ?? undefined,
        env: input.env?.map((e) => ({ key: e.key, value: e.value })),
        composeService: input.composeService ?? null,
        composePort: input.composePort ?? null,
        exposes: input.exposes
          ? input.exposes.map((e) => ({
              service: e.service,
              port: e.port,
              host: e.host ?? undefined,
            }))
          : null,
        autoDomain: input.autoDomain ?? null,
        mounts: input.mounts
          ? input.mounts.map((m) => ({ filePath: m.filePath, content: m.content }))
          : null,
      }),
  }),
  renameProject: t.field({
    type: ProjectRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, name }) => {
      await renameProject(id, name);
      return reloadProject(id);
    },
  }),
  updateProjectBuild: t.field({
    type: ProjectRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      build: t.arg({ type: BuildConfigInput, required: true }),
    },
    resolve: async (_r, { id, build }) => {
      await updateProjectBuild(id, build as never);
      return reloadProject(id);
    },
  }),
  updateProjectSource: t.field({
    type: ProjectRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: UpdateSourceInputType, required: true }),
    },
    resolve: async (_r, { id, input }) => {
      await updateProjectSource(id, {
        source: input.source,
        repo: input.repo
          ? {
              provider: input.repo.provider as never,
              url: input.repo.url,
              repo: input.repo.repo,
              branch: input.repo.branch,
              installationId: input.repo.installationId ?? undefined,
            }
          : null,
        dockerImage: input.dockerImage ?? null,
        serverId: input.serverId ?? undefined,
        compose: input.compose ?? undefined,
        expose: input.expose
          ? { service: input.expose.service, port: input.expose.port }
          : input.expose === null
            ? null
            : undefined,
        exposes: input.exposes
          ? input.exposes.map((e) => ({
              service: e.service,
              port: e.port,
              host: e.host ?? undefined,
            }))
          : undefined,
      });
      return reloadProject(id);
    },
  }),
  setProjectVolumes: t.field({
    type: ProjectRef,
    authScopes: { capability: "deploy" },
    description:
      "Replace a single-container project's volumes (named + host bind mounts).",
    args: {
      id: t.arg.string({ required: true }),
      volumes: t.arg({ type: [VolumeInput], required: true }),
    },
    resolve: async (_r, { id, volumes }) => {
      await setProjectVolumes(
        id,
        volumes.map((v) => ({
          id: v.id ?? "",
          type: v.type === "host" ? ("host" as const) : ("named" as const),
          name: v.name ?? "",
          hostPath: v.hostPath ?? undefined,
          mountPath: v.mountPath,
          readOnly: v.readOnly ?? false,
        })),
      );
      return reloadProject(id);
    },
  }),
  setProjectAutoDeploy: t.field({
    type: ProjectRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      value: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { id, value }) => {
      await setAutoDeploy(id, value);
      return reloadProject(id);
    },
  }),
  updateProjectLogo: t.field({
    type: ProjectRef,
    authScopes: { capability: "deploy" },
    args: {
      id: t.arg.string({ required: true }),
      logo: t.arg.string({ required: false }),
    },
    resolve: async (_r, { id, logo }) => {
      await updateProjectLogo(id, logo ?? null);
      return reloadProject(id);
    },
  }),
  stopProject: t.field({
    type: ProjectRef,
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await stopProject(id);
      return reloadProject(id);
    },
  }),
  startProject: t.field({
    type: ProjectRef,
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await startProject(id);
      return reloadProject(id);
    },
  }),
  rebuildProject: t.field({
    type: ProjectRef,
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await rebuildProject(id);
      return reloadProject(id);
    },
  }),
  deleteProject: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy" },
    description: "Delete the project and tear down its stack. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteProject(id);
      return true;
    },
  }),
  renderComposeStack: t.field({
    type: "String",
    nullable: true,
    authScopes: { loggedIn: true },
    description: "Render the docker-compose stack a project would deploy.",
    args: { projectId: t.arg.string({ required: true }) },
    resolve: async (_r, { projectId }) => {
      // Team-scope the request before rendering (the render fn is unscoped).
      const project = await getProjectById(projectId);
      if (!project) throw new Error("Project not found");
      return renderProjectStack(project.id);
    },
  }),
  redeploy: t.field({
    type: DeploymentRef,
    authScopes: { capability: "deploy" },
    args: { projectId: t.arg.string({ required: true }) },
    resolve: (_r, { projectId }) => redeploy(projectId),
  }),
  cancelDeployment: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await cancelDeployment(id);
      return true;
    },
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
}));

/** Reload a project by id after a void mutation so we can return the entity. */
async function reloadProject(id: string): Promise<ProjectSummary> {
  const all = await listProjects();
  const found = all.find((p) => p.id === id);
  if (!found) throw new Error("Project not found");
  return found;
}
