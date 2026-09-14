import { builder } from "../../builder";
import { DeploymentStatusEnum, DeploymentEnvironmentEnum } from "../enums";
import { AppRef } from "./app-object";
import { DeploymentRef } from "./deployment-object";
import {
  composeNameClashes,
  type ComposeNameClash,
} from "@/lib/data/apps/create";
import { listApps, getAppBySlug } from "@/lib/data/apps/listing";
import { previewRepoFramework } from "@/lib/data/apps/settings";
import {
  appTransferInfo,
  type AppTransferInfo,
  type AppTransferTarget,
} from "@/lib/data/app-transfer";
import {
  frameworkById,
  type FrameworkDefinition,
} from "@/lib/apps/framework-catalog";
import {
  listDeployments,
  getDeployment,
} from "@/lib/data/deployments/deployment-queries";
import type { BuildMethod } from "@/lib/types/build";

const ComposeNameClashesInputType = builder.inputType(
  "ComposeNameClashesInput",
  {
    fields: (t) => ({
      compose: t.string({ required: true }),
      serverId: t.string({ required: false }),
      folderId: t.string({ required: false }),
      projectId: t.string({ required: false }),
      environmentId: t.string({ required: false }),
    }),
  },
);

const ComposeNameClashRef = builder
  .objectRef<ComposeNameClash>("ComposeNameClash")
  .implement({
    description:
      "A service name this stack shares with an app or database already on the " +
      "destination network, and what the rename would call it.",
    fields: (t) => ({
      name: t.exposeString("name"),
      owner: t.exposeString("owner", {
        description: "The app or database already answering to the name.",
      }),
      renamedTo: t.exposeString("renamedTo", {
        description:
          "The free name `createApp(renameClashes: true)` would use.",
      }),
    }),
  });

// What one read of a repository yields the new-app wizard.
interface RecognizedFrameworkDTO {
  framework: FrameworkDefinition | null;
  staticOutput: string | null;
  startCommand: string | null;
  buildCommand: string | null;
}

const RecognizedFrameworkRef = builder
  .objectRef<RecognizedFrameworkDTO>("RecognizedFramework")
  .implement({
    description:
      "What Deplo read in a repository before an app exists for it: the " +
      "JavaScript framework backing it, and the build command the repository " +
      "declares for ITSELF in its package.json. Never invented from the " +
      "framework - null means the repo said nothing and the builder decides.",
    fields: (t) => ({
      id: t.string({
        nullable: true,
        description:
          'Stable framework id, e.g. "nextjs" - also the key for its brand ' +
          "mark. Null for a repo with no framework Deplo knows.",
        resolve: (f) => f.framework?.id ?? null,
      }),
      name: t.string({
        nullable: true,
        description: 'Display name, e.g. "Next.js".',
        resolve: (f) => f.framework?.name ?? null,
      }),
      defaultPort: t.int({
        nullable: true,
        description:
          "The port this framework's production server binds when nothing tells " +
          "it otherwise - what a new app's container port defaults to.",
        resolve: (f) => f.framework?.defaultPort ?? null,
      }),
      staticOutput: t.exposeString("staticOutput", {
        nullable: true,
        description:
          "The directory to SERVE, for a framework whose production artifact is " +
          "a directory no builder serves (Gatsby, Eleventy, Docusaurus, and an " +
          "Angular workspace, whose path carries its project's name).",
      }),
      startCommand: t.exposeString("startCommand", {
        nullable: true,
        description:
          "The FRAMEWORK's own production start, for one no builder derives a " +
          "start for (SvelteKit on adapter-node, AdonisJS). Never the repo's " +
          "`start` script, which is as often its dev server.",
      }),
      buildCommand: t.exposeString("buildCommand", {
        nullable: true,
        description:
          "The repository's own build script, spelled for its lockfile's " +
          'package manager (e.g. "pnpm run build").',
      }),
    }),
  });

const AppTransferTargetRef = builder
  .objectRef<AppTransferTarget>("AppTransferTarget")
  .implement({
    description:
      "A team the viewer could hand this app to - one of their OWN other teams " +
      "where they hold the deploy capability.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
      serverAvailable: t.exposeBoolean("serverAvailable", {
        description:
          "False when the app's server is restricted and not shared with that " +
          "team - the transfer is refused until an instance admin grants access.",
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
          "Backup schedules targeting this app - removed on transfer, because " +
          "they point at the current team's backup destination.",
      }),
      githubConnected: t.exposeBoolean("githubConnected"),
      gitConnectionLabel: t.exposeString("gitConnectionLabel", {
        nullable: true,
        description:
          "The git connection authenticating this app's clone, or null. It is " +
          "always dropped on transfer - a token is owned by the current team " +
          "and cannot be assumed to reach the repository from another one.",
      }),
      targets: t.field({
        type: [AppTransferTargetRef],
        resolve: (x) => x.targets,
      }),
    }),
  });

builder.queryFields((t) => ({
  composeNameClashes: t.field({
    type: [ComposeNameClashRef],
    authScopes: { capability: "create_apps" },
    description:
      "The service names a stack would share with something already on the " +
      "network it lands on - what `createApp` refuses it over, asked before " +
      "creating so the caller can pass `renameClashes` instead. Empty when " +
      "nothing clashes.",
    args: {
      input: t.arg({ type: ComposeNameClashesInputType, required: true }),
    },
    resolve: (_r, { input }) =>
      composeNameClashes({
        compose: input.compose,
        serverId: input.serverId ?? undefined,
        folderId: input.folderId ?? null,
        projectId: input.projectId ?? null,
        environmentId: input.environmentId ?? null,
      }),
  }),
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
      "Read a GitHub repository before an app exists for it - the framework " +
      "and the build command the new-app wizard prefills while you pick a repo. " +
      "Null when there is nothing to read at all: a build method other than " +
      "Nixpacks / Railpack (the only ones this applies to), a repository Deplo " +
      "can't read, or one with neither a framework nor a script. Reads only; " +
      "the app's first deploy re-derives and stores the framework.",
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
    resolve: async (_r, args) => {
      const hints = await previewRepoFramework({
        repo: args.repo,
        url: args.url,
        branch: args.branch,
        installationId: args.installationId,
        // Untrusted string: anything that isn't a real method simply fails the
        // Nixpacks/Railpack test inside and yields nothing.
        buildMethod: args.buildMethod as BuildMethod,
        rootDirectory: args.rootDirectory,
      });
      const framework = frameworkById(hints.framework);
      if (!framework && !hints.buildCommand) return null;
      return {
        framework,
        staticOutput: hints.staticOutput,
        startCommand: hints.startCommand,
        buildCommand: hints.buildCommand,
      };
    },
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
