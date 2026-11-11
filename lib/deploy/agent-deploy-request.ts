import "server-only";

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SourceKind,
  BuildKind,
  type DeployRequest,
  type RegistryAuth,
  type BuildSpec,
} from "../agent/gen/agent";
import { stackFilesDir } from "./deploy-key";
import { filesBindSources } from "./file-binds";
import { buildConfigFor, normalizeBuildConfig } from "../frameworks";
import { autoComposeSkip } from "./build/source-compose";
import type { BuildConfig } from "../types/build";

// What a deploy asks of the server agent: the build plan and the request made from it.

export type AgentBuildPlan =
  | {
      kind: "dockerfile";
      buildDir: string;
      build: BuildConfig;
    }
  | {
      kind: "image";
      image: string;
      pull: boolean;
    }
  | {
      kind: "git";
      url: string;
      branch: string;
      // A full SHA to build instead of the branch tip (a rollback that rebuilds).
      commit?: string;
      subdir: string;
      submodules?: boolean;
      build: BuildConfig;
    }
  | {
      kind: "compose";
      mounts: { filePath: string; content: string }[];
    }
  | {
      // The compose file the source carries, built and brought up from its checkout.
      kind: "source-compose";
      source:
        | {
            kind: "git";
            url: string;
            commit: string;
            subdir: string;
            submodules?: boolean;
          }
        | { kind: "upload"; buildDir: string };
      composeFile: string;
    };

export function agentCanHandle(build: BuildConfig | null): boolean {
  if (!build) return true;
  void normalizeBuildConfig(build).buildMethod;
  return true;
}

// Detect automatically falls back to Railpack, so an agent without auto detection still builds it.
export function agentCapabilityForMethod(
  build: BuildConfig | null,
): string | null {
  if (!build) return null;
  const b = normalizeBuildConfig(build);
  if (b.methodAuto || b.buildMethod === "railpack") return "deploy.railpack";
  if (b.buildMethod === "compose") return "deploy.compose.source";
  return null;
}

export function buildSpecFor(build: BuildConfig): BuildSpec {
  const b = normalizeBuildConfig(build);
  const runtimeVersion = (b.runtimeVersion ?? "").trim();
  return {
    method: b.methodAuto ? "auto" : b.buildMethod,
    port: b.port ?? 0,
    installCommand: b.installCommand ?? "",
    buildCommand: b.buildCommand ?? "",
    startCommand: b.startCommand ?? "",
    outputDirectory: b.outputDirectory ?? "",
    skipInstall: b.installCommand === "",
    // A proto3 string cannot carry NULL ("work it out") apart from "" ("run nothing"), so these say it.
    skipBuild: b.buildCommand === "",
    runtimeVersion,
    runtimeLanguage: runtimeVersion ? "node" : "",
    staticSinglePageApp: b.methodSettings.staticSinglePageApp ?? false,
    autoMethod: b.methodAuto,
    composeFile: b.methodSettings.composeFile?.trim() ?? "",
  };
}

export interface DockerfileDescriptor {
  dockerfilePath: string;
  contextPath: string;
  targetStage: string;
  generated: boolean;
  generatedDockerfile: string;
}

export function explicitDockerfileDescriptor(
  build: BuildConfig,
): DockerfileDescriptor {
  const s = build.methodSettings;
  return {
    dockerfilePath: s.dockerfilePath?.trim() || "Dockerfile",
    contextPath: s.dockerContextPath?.trim() || ".",
    targetStage: s.dockerBuildStage?.trim() || "",
    generated: false,
    generatedDockerfile: "",
  };
}

export async function buildDeployRequest(opts: {
  deployId: string;
  slug: string;
  appId: string;
  imageRef: string;
  composeYaml: string;
  network: string;
  env: Record<string, string>;
  plan: AgentBuildPlan;
  readyTimeoutMs?: number;
  noCache?: boolean;
  pullBase?: boolean;
  forceRecreate?: boolean;
  composeUpArgs?: string[];
  buildOnly?: boolean;
  registryAuth?: RegistryAuth[];
}): Promise<DeployRequest> {
  const base: DeployRequest = {
    deployId: opts.deployId,
    slug: opts.slug,
    projectId: opts.appId,
    imageRef: opts.imageRef,
    sourceKind: SourceKind.SOURCE_KIND_UNSPECIFIED,
    buildKind: BuildKind.BUILD_KIND_UNSPECIFIED,
    dockerfile: undefined,
    composeYaml: opts.composeYaml,
    network: opts.network,
    env: opts.env,
    readyTimeoutMs: opts.readyTimeoutMs ?? 60_000,
    contextTar: new Uint8Array(0),
    pullImage: false,
    mounts: [],
    devWorkspaceSubdir: "",
    buildSpec: undefined,
    noBuildCache: opts.noCache ?? false,
    forceRecreate: opts.forceRecreate ?? false,
    composeUpArgs: opts.composeUpArgs ?? [],
    buildOnly: opts.buildOnly ?? false,
    registryAuth: opts.registryAuth ?? [],
    filesBindSources: filesBindSources(
      opts.composeYaml,
      stackFilesDir(opts.slug),
    ),
    ready: undefined,
    githubToken: "",
    pullBaseImages: opts.pullBase ?? false,
    standInComposeYaml: "",
    restartRule: undefined,
    startAfterReady: [],
  };

  if (opts.plan.kind === "compose") {
    return {
      ...base,
      sourceKind: SourceKind.SOURCE_KIND_COMPOSE,
      buildKind: BuildKind.BUILD_KIND_NONE,
      mounts: opts.plan.mounts.map((m) => ({
        path: m.filePath,
        content: m.content,
      })),
    };
  }

  if (opts.plan.kind === "image") {
    return {
      ...base,
      sourceKind: SourceKind.SOURCE_KIND_IMAGE,
      buildKind: BuildKind.BUILD_KIND_NONE,
      pullImage: opts.plan.pull,
    };
  }

  if (opts.plan.kind === "git") {
    return {
      ...base,
      sourceKind: SourceKind.SOURCE_KIND_GIT,
      ...buildFieldsFor(opts.plan.build),
      git: {
        url: opts.plan.url,
        branch: opts.plan.branch,
        commit: opts.plan.commit ?? "",
        subdir: opts.plan.subdir,
        token: "",
        submodules: opts.plan.submodules ?? false,
      },
    };
  }

  if (opts.plan.kind === "source-compose") {
    const { source, composeFile } = opts.plan;
    return {
      ...base,
      buildKind: BuildKind.BUILD_KIND_COMPOSE,
      buildSpec: {
        ...buildSpecFor(buildConfigFor({ buildMethod: "compose" })),
        composeFile,
      },
      ...(source.kind === "git"
        ? {
            sourceKind: SourceKind.SOURCE_KIND_GIT,
            git: {
              url: source.url,
              branch: "",
              commit: source.commit,
              subdir: source.subdir,
              token: "",
              submodules: source.submodules ?? false,
            },
          }
        : { sourceKind: SourceKind.SOURCE_KIND_UPLOAD }),
    };
  }

  // An upload's method is resolved against its own files before the build.
  const { buildDir, build } = opts.plan;
  const normalized = await resolveUploadMethod(buildDir, build);
  return {
    ...base,
    sourceKind: SourceKind.SOURCE_KIND_UPLOAD,
    ...buildFieldsFor(normalized),
  };
}

function buildFieldsFor(build: BuildConfig): Partial<DeployRequest> {
  const b = normalizeBuildConfig(build);
  if (b.buildMethod === "dockerfile" && !b.methodAuto)
    return {
      buildKind: BuildKind.BUILD_KIND_DOCKERFILE,
      dockerfile: explicitDockerfileDescriptor(b),
    };
  // With composeYaml empty this only reads the compose file: the stack is rendered from it next.
  if (b.buildMethod === "compose" && !b.methodAuto)
    return {
      buildKind: BuildKind.BUILD_KIND_COMPOSE,
      buildSpec: buildSpecFor(b),
    };
  return {
    buildKind: BuildKind.BUILD_KIND_RAILPACK,
    buildSpec: buildSpecFor(b),
  };
}

export const COMPOSE_FILE_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

// Detect automatically for an upload, the same order the agent applies to a clone.
export async function resolveUploadMethod(
  buildDir: string,
  build: BuildConfig,
): Promise<BuildConfig> {
  const b = normalizeBuildConfig(build);
  if (!b.methodAuto) return b;
  if (await fileExists(join(buildDir, "Dockerfile")))
    return { ...b, buildMethod: "dockerfile", methodAuto: false };
  const compose = await findComposeFile(buildDir, b.methodSettings.composeFile);
  const deployable =
    compose != null &&
    autoComposeSkip(
      compose,
      await readFile(join(buildDir, compose), "utf8").catch(() => ""),
    ) == null;
  return {
    ...b,
    buildMethod: deployable ? "compose" : "railpack",
    methodAuto: false,
  };
}

export async function findComposeFile(
  buildDir: string,
  preferred?: string | null,
): Promise<string | null> {
  for (const name of preferred?.trim()
    ? [preferred.trim()]
    : COMPOSE_FILE_NAMES)
    if (await fileExists(join(buildDir, name))) return name;
  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
