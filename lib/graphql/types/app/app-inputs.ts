import { builder } from "../../builder";
import { DeploySourceEnum } from "../enums";
import { MountPropagationEnum, VolumeKindEnum } from "./app-object";
import type { GitRepo } from "@/lib/types/build";

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
    triggerType: t.string({ required: false, description: '"push" or "tag".' }),
    watchPaths: t.stringList({ required: false }),
    submodules: t.boolean({ required: false }),
  }),
});

const KNOWN_PROVIDERS = new Set<GitRepo["provider"]>([
  "github",
  "gitlab",
  "bitbucket",
  "gitea",
  "git",
]);

export function repoInputToGitRepo(repo: {
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

export const BuildConfigInput = builder.inputType("BuildConfigInput", {
  description:
    "Partial build configuration; only the provided fields are changed.",
  fields: (t) => ({
    buildMethod: t.string({ required: false }),
    rootDir: t.string({ required: false }),
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
    "An extra (non-primary) routed host: the compose service + port it targets, " +
    "its hostname and the path it answers on. No hostname ⇒ one is generated. " +
    "Registered as an auto Domain row at creation; the `domains` table is the " +
    "sole routing source after.",
  fields: (t) => ({
    service: t.string({ required: true }),
    port: t.int({ required: true }),
    host: t.string({ required: false }),
    path: t.string({ required: false }),
  }),
});

const AppEnvInput = builder.inputType("AppEnvInput", {
  description: "An initial environment variable for a new app.",
  fields: (t) => ({
    key: t.string({ required: true }),
    value: t.string({ required: true }),
    type: t.string({
      required: false,
      description:
        '"plain" or "secret". Omitted is plain - nothing is typed secret on ' +
        "your behalf; a secret is write-only from the moment it lands.",
    }),
  }),
});

const MountInput = builder.inputType("MountInput", {
  description:
    "A config file a template materialises into its stack at deploy.",
  fields: (t) => ({
    filePath: t.string({ required: true }),
    content: t.string({ required: true }),
  }),
});

export const VolumeInput = builder.inputType("VolumeInput", {
  description: "A persistent volume mounted into an app.",
  fields: (t) => ({
    id: t.string({ required: false }),
    type: t.field({ type: VolumeKindEnum, required: false }),
    name: t.string({ required: false }),
    projectPath: t.string({ required: false }),
    hostPath: t.string({ required: false }),
    service: t.string({ required: false }),
    mountPath: t.string({ required: true }),
    readOnly: t.boolean({ required: false }),
    propagation: t.field({ type: MountPropagationEnum, required: false }),
  }),
});

export const PublishedPortInput = builder.inputType("PublishedPortInput", {
  description: "A host port an app publishes.",
  fields: (t) => ({
    id: t.string({ required: false }),
    published: t.int({ required: true }),
    target: t.int({ required: true }),
    protocol: t.string({ required: false }),
  }),
});

export const CreateAppInputType = builder.inputType("CreateAppInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    source: t.field({ type: DeploySourceEnum, required: true }),
    repo: t.field({ type: GitRepoInput, required: false }),
    dockerImage: t.string({ required: false }),
    logo: t.string({ required: false }),
    logoFromTemplate: t.boolean({
      required: false,
      description:
        "The logo above is a template's own. Deplo reads it once for the plate that keeps a monochrome mark visible on both themes.",
    }),
    compose: t.string({ required: false }),
    serverId: t.string({ required: false }),
    buildServerId: t.string({
      required: false,
      description:
        "Where the app COMPILES, when that is not where it runs. Omitted is " +
        "Automatic - a build-only server if the fleet has one.",
    }),
    composeUpArgs: t.string({
      required: false,
      description:
        "Extra flags appended to `docker compose up` for a compose stack. " +
        "Validated against the same allow-list the app's settings use.",
    }),
    sharedVarIds: t.stringList({
      required: false,
      description:
        "Shared variables to link to the new app, so its FIRST deploy already " +
        "carries them (ADR-0012: linking is the injection, and it is opt-in).",
    }),
    build: t.field({ type: BuildConfigInput, required: false }),
    autoDeploy: t.boolean({ required: false }),
    deploy: t.boolean({
      required: false,
      description: "Whether to start the first deployment. Defaults to true.",
    }),
    env: t.field({ type: [AppEnvInput], required: false }),
    composeService: t.string({ required: false }),
    composePort: t.int({ required: false }),
    extraDomains: t.field({ type: [ExtraDomainInput], required: false }),
    autoDomain: t.string({ required: false }),
    autoDomainPath: t.string({ required: false }),
    mounts: t.field({ type: [MountInput], required: false }),
    folderId: t.string({ required: false }),
    projectId: t.string({ required: false }),
    environmentId: t.string({ required: false }),
    renameClashes: t.boolean({
      required: false,
      description:
        "Rename a service whose name a neighbour on the destination network " +
        "already answers to (`db` becomes `db-2`), carrying its references, " +
        "instead of refusing the stack. See `composeNameClashes`.",
    }),
  }),
});

export const UpdateSourceInputType = builder.inputType("UpdateSourceInput", {
  fields: (t) => ({
    source: t.field({ type: DeploySourceEnum, required: true }),
    repo: t.field({ type: GitRepoInput, required: false }),
    dockerImage: t.string({ required: false }),
    serverId: t.string({ required: false }),
    compose: t.string({ required: false }),
  }),
});
