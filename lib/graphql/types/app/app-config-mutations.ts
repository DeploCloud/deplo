import { builder } from "../../builder";
import { remapBuildInput } from "../build-input";
import { ResourceLimitsInputType } from "../resource-limits";
import { HealthCheckInputType } from "../health-check";
import { AppRef, reloadApp } from "./app-object";
import {
  BuildConfigInput,
  CreateAppInputType,
  PublishedPortInput,
  UpdateSourceInputType,
  VolumeInput,
  repoInputToGitRepo,
} from "./app-inputs";
import {
  updateAppBuild,
  setAppBuildServer,
  clearAppBuildCache,
} from "@/lib/data/apps/build-settings";
import { createApp } from "@/lib/data/apps/create";
import { reorderApps } from "@/lib/data/apps/listing";
import { updateAppLogo, redetectAppLogo } from "@/lib/data/apps/logo";
import { setAppPorts } from "@/lib/data/apps/ports";
import {
  updateAppResources,
  type ResourceLimitsInput,
} from "@/lib/data/apps/resources";
import {
  setAutoDeploy,
  renameApp,
  updateAppHealthCheck,
  setAppFramework,
  setAppComposeUpArgs,
  setAppRestartLoopGuard,
} from "@/lib/data/apps/settings";
import { updateAppSource } from "@/lib/data/apps/source";
import { setAppVolumes } from "@/lib/data/apps/volumes";
import {
  revealDeployHook,
  rotateDeployHook,
  setDeployHookEnabled,
} from "@/lib/data/deploy-hook";

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
        logoFromTemplate: input.logoFromTemplate ?? false,
        compose: input.compose ?? null,
        serverId: input.serverId ?? undefined,
        buildServerId: input.buildServerId ?? null,
        composeUpArgs: input.composeUpArgs ?? null,
        sharedVarIds: input.sharedVarIds ?? null,
        build: input.build
          ? (remapBuildInput(input.build) as never)
          : undefined,
        autoDeploy: input.autoDeploy ?? undefined,
        deploy: input.deploy ?? undefined,
        env: input.env?.map((e) => ({
          key: e.key,
          value: e.value,
          type: e.type === "secret" || e.type === "plain" ? e.type : undefined,
        })),
        composeService: input.composeService ?? null,
        composePort: input.composePort ?? null,
        extraDomains: input.extraDomains
          ? input.extraDomains.map((e) => ({
              service: e.service,
              port: e.port,
              host: e.host ?? "",
              path: e.path ?? null,
            }))
          : null,
        autoDomain: input.autoDomain ?? null,
        autoDomainPath: input.autoDomainPath ?? null,
        mounts: input.mounts
          ? input.mounts.map((m) => ({
              filePath: m.filePath,
              content: m.content,
            }))
          : null,
        folderId: input.folderId ?? null,
        projectId: input.projectId ?? null,
        environmentId: input.environmentId ?? null,
        renameClashes: input.renameClashes ?? undefined,
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
      "Choose which server BUILDS this app. Null buildServerId is Automatic (a build-only server if the fleet has one this team can reach and its architecture matches, otherwise build where the app runs); passing the app's own server id means 'always build here'. buildFallback decides what happens when that host cannot compile: try the fleet's build fallbacks and then the app's own server (the default), or fail the deploy. Changing either never starts a deploy.",
    args: {
      id: t.arg.string({ required: true }),
      buildServerId: t.arg.string({ required: false }),
      buildFallback: t.arg.boolean({ required: false }),
    },
    resolve: async (_r, { id, buildServerId, buildFallback }) => {
      await setAppBuildServer(id, {
        buildServerId: buildServerId ?? null,
        buildFallback: buildFallback ?? undefined,
      });
      return reloadApp(id);
    },
  }),
  clearAppBuildCache: t.field({
    type: AppRef,
    description:
      "Clear this app's build cache: the next deployment builds from scratch " +
      "instead of reusing cached layers, then caches again. Nothing is pruned " +
      "on the server - the build cache is shared by every app on it.",
    authScopes: { capability: "configure_apps" },
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await clearAppBuildCache(id);
      return reloadApp(id);
    },
  }),
  setAppFramework: t.field({
    type: AppRef,
    authScopes: { capability: "configure_apps" },
    description:
      "Correct the framework Deplo recognised in this app's source (a catalog " +
      'id such as "vite"), or pass null to go back to trusting detection. The ' +
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
  updateAppHealthCheck: t.field({
    type: AppRef,
    description:
      "Save the app's health check, or send no input to turn it off. Applied on the next deploy, because the block is baked into the rendered compose. Refused for a compose stack: that YAML is its author's, and a `healthcheck:` written there is the one that runs.",
    authScopes: { capability: "configure_apps" },
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: HealthCheckInputType, required: false }),
    },
    resolve: async (_r, { id, input }) => {
      await updateAppHealthCheck(
        id,
        input
          ? {
              type: input.type,
              path: input.path ?? null,
              port: input.port ?? null,
              command: input.command ?? null,
              intervalS: input.intervalS,
              timeoutS: input.timeoutS,
              retries: input.retries,
              startPeriodS: input.startPeriodS,
            }
          : null,
      );
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
      "Replace an app's volumes (named, app-files, and host bind mounts). Compose-stack apps included - each volume names the service it mounts into.",
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
              : v.type === "app" || v.type === "service"
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
  setAppPorts: t.field({
    type: AppRef,
    authScopes: { capability: "configure_apps" },
    description:
      "Replace the host ports an app publishes. Needs the publish-ports grant, and is refused for a compose stack, which publishes its own.",
    args: {
      id: t.arg.string({ required: true }),
      ports: t.arg({ type: [PublishedPortInput], required: true }),
    },
    resolve: async (_r, { id, ports }) => {
      await setAppPorts(
        id,
        ports.map((p) => ({
          id: p.id ?? "",
          published: p.published,
          target: p.target,
          protocol: p.protocol === "udp" ? ("udp" as const) : ("tcp" as const),
        })),
      );
      return reloadApp(id);
    },
  }),
  setAppRestartLoopGuard: t.field({
    type: AppRef,
    authScopes: { capability: "configure_apps" },
    description:
      "Turn restart loop protection on or off for one app. Applies at once - " +
      "there is nothing to redeploy.",
    args: {
      id: t.arg.string({ required: true }),
      value: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { id, value }) => {
      await setAppRestartLoopGuard(id, value);
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
      "Auto-detect a favicon from the app's own files - its GitHub repo, its uploaded archive, or (for a compose stack) its files dir on its server, and set it as the logo. Errors if none is found.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await redetectAppLogo(id);
      return reloadApp(id);
    },
  }),
}));
