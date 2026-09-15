import "server-only";

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  SourceKind,
  BuildKind,
  DeployPhase,
  type DeployRequest,
  type DeployEvent,
  type RegistryAuth,
  type BuildSpec,
} from "../agent/gen/agent";
import { explainNetworkError } from "./network";
import { status as GrpcStatus } from "@grpc/grpc-js";
import { connectAgent } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { agentPreflight } from "../infra/agent-client/preflight";
import { stackFilesDir } from "./deploy-key";
import { fileBindsUnderFilesDir } from "./file-binds";
import { composeDeployArgs } from "./compose-args";
import { loadRegistryAuthsForApp } from "../data/registries";
import { cleanToolVersion } from "../data/app-graph-rows/build";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { appVolumes as appVolumesTable } from "../db/schema/control-plane/apps";
import { generateDockerfile } from "./dockerfile";
import {
  normalizeBuildConfig,
  DEFAULT_NODE_MAJOR,
  usesDefaultNodeMajor,
} from "../frameworks";
import type { BuildConfig, BuildMethod } from "../types/build";
import type { LogLevel } from "../types/deployment";

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
      subdir: string;
      build: BuildConfig;
    }
  | {
      kind: "compose";
      mounts: { filePath: string; content: string }[];
    };

export function agentCanHandle(build: BuildConfig | null): boolean {
  if (!build) return true;
  void normalizeBuildConfig(build).buildMethod;
  return true;
}

const HEAVY_METHOD: Record<
  string,
  { kind: BuildKind; capability: string } | undefined
> = {
  static: { kind: BuildKind.BUILD_KIND_STATIC, capability: "deploy.static" },
  nixpacks: {
    kind: BuildKind.BUILD_KIND_NIXPACKS,
    capability: "deploy.nixpacks",
  },
  railpack: {
    kind: BuildKind.BUILD_KIND_RAILPACK,
    capability: "deploy.railpack",
  },
};

export function agentCapabilityForMethod(
  build: BuildConfig | null,
): string | null {
  if (!build) return null;
  return (
    HEAVY_METHOD[normalizeBuildConfig(build).buildMethod]?.capability ?? null
  );
}

function heavyBuildKind(method: BuildMethod): BuildKind | null {
  return HEAVY_METHOD[method]?.kind ?? null;
}

export function buildSpecFor(build: BuildConfig): BuildSpec {
  const b = normalizeBuildConfig(build);
  const pinned = (b.runtimeVersion ?? "").trim();
  const runtimeVersion =
    pinned || (usesDefaultNodeMajor(b.buildMethod) ? DEFAULT_NODE_MAJOR : "");
  return {
    method: b.buildMethod,
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
    nixpacksPublishDirectory:
      b.methodSettings.nixpacksPublishDirectory?.trim() ?? "",
    herokuVersion: "",
    railpackVersion: cleanToolVersion(b.methodSettings.railpackVersion) ?? "",
    staticSinglePageApp: b.methodSettings.staticSinglePageApp ?? false,
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

export interface AgentDeploySink {
  log: (level: LogLevel, text: string) => void;
  phase?: (phase: DeployPhase) => void;
}

export interface AgentDeployResult {
  ready: boolean;
  commitSha: string;
}

export async function fileVolumePathsForApp(appId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ path: appVolumesTable.projectPath })
    .from(appVolumesTable)
    .where(
      and(eq(appVolumesTable.appId, appId), eq(appVolumesTable.type, "app")),
    );
  return rows.map((r) => r.path ?? "").filter(Boolean);
}

async function filesPathState(
  conn: Pick<AgentConnection, "readFile">,
  slug: string,
  rel: string,
): Promise<"file" | "folder" | "missing"> {
  try {
    await conn.readFile(slug, rel);
    return "file";
  } catch (e) {
    const code = (e as { code?: number } | null)?.code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === GrpcStatus.NOT_FOUND) return "missing";
    if (code === GrpcStatus.INVALID_ARGUMENT && /not a file/i.test(msg))
      return "folder";
    throw e;
  }
}

// Docker answers a missing bind source with an empty DIRECTORY, so file-shaped binds are created first.
export async function ensureFileBinds(
  conn: Pick<
    AgentConnection,
    "readFile" | "writeFile" | "listFiles" | "deleteFile"
  >,
  slug: string,
  rels: string[],
  log: (level: "info" | "warn", text: string) => void,
): Promise<void> {
  for (const rel of rels) {
    if (rel === ".env") continue;
    const state = await filesPathState(conn, slug, rel);
    if (state === "file") continue;
    if (state === "folder") {
      const entries = await conn.listFiles(slug, rel).catch((e) => {
        if ((e as { code?: number } | null)?.code === GrpcStatus.NOT_FOUND)
          return [];
        throw e;
      });
      if (entries.length > 0) {
        log(
          "warn",
          `${rel} in this app's Files is a folder with content, so it is mounted as a folder.`,
        );
        continue;
      }
      await conn.deleteFile(slug, rel);
    }
    await conn.writeFile(slug, rel, "");
    log(
      "info",
      `Created an empty ${rel} in this app's Files, mounted as a file.`,
    );
  }
}

export async function runAgentDeploy(opts: {
  serverId: string;
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
  forceRecreate?: boolean;
  composeUpArgs?: string[];
  buildOnly?: boolean;
  forkPreview?: boolean;
  sink: AgentDeploySink;
}): Promise<AgentDeployResult> {
  const hello = await agentPreflight(opts.serverId);
  if (!hello.dockerAvailable) {
    throw new AgentUnavailableError(
      "the agent reports Docker is not available on the target server",
    );
  }
  // A HARD gate: an older agent reads `build_only` as absent and runs production on the build server.
  if (opts.buildOnly && !hello.capabilities.includes("deploy.build-only")) {
    throw new AgentUnavailableError(
      "this build server's agent is too old to build without deploying - update it " +
        "from Settings → Servers, or build this app on its own server",
    );
  }
  if (opts.noCache && !hello.capabilities.includes("deploy.nocache")) {
    opts.sink.log(
      "warn",
      "This server's agent is too old to skip the build cache - this build may reuse " +
        "cached layers. Update the agent (reissue the install command from the server's actions menu).",
    );
  }
  if (
    opts.forceRecreate &&
    !hello.capabilities.includes("deploy.force-recreate")
  ) {
    opts.sink.log(
      "warn",
      "This server's agent is too old to force a fresh container, if nothing about the " +
        "stack changed, the running container is kept. Update the agent (reissue the install " +
        "command from the server's actions menu).",
    );
  }
  const plannedBuild =
    opts.plan.kind === "dockerfile" || opts.plan.kind === "git"
      ? opts.plan.build
      : null;
  if (
    (plannedBuild?.installCommand === "" ||
      plannedBuild?.buildCommand === "") &&
    !hello.capabilities.includes("build.skip_steps")
  ) {
    opts.sink.log(
      "warn",
      "This server's agent is too old to skip an install or build step - it is detecting " +
        "one instead. Update the agent (reissue the install command from the server's actions menu).",
    );
  }
  const req = await buildDeployRequest({
    ...opts,
    // A fork preview is a stranger's code, so every pull of this deploy goes unauthenticated.
    registryAuth: opts.forkPreview
      ? []
      : await loadRegistryAuthsForApp(opts.appId),
  });
  if (
    req.composeUpArgs.length &&
    !hello.capabilities.includes("deploy.compose-args")
  ) {
    opts.sink.log(
      "warn",
      `This server's agent is too old to apply this app's compose flags (${req.composeUpArgs.join(" ")}) - ` +
        "it is bringing the stack up without them. Update the agent (reissue the install " +
        "command from the server's actions menu).",
    );
  }

  // A reattach replays everything AFTER this seq, so a reconnect never double-logs and misses nothing.
  const cursor = { seq: 0 };

  let started = false;
  const first = await connectAgent(opts.serverId);
  if (!opts.buildOnly) {
    try {
      await ensureFileBinds(
        first,
        opts.slug,
        fileBindsUnderFilesDir(
          opts.composeYaml,
          stackFilesDir(opts.slug),
          req.mounts.map((m) => m.path),
          await fileVolumePathsForApp(opts.appId),
        ),
        (level, text) => opts.sink.log(level, text),
      );
    } catch (e) {
      first.close();
      throw e;
    }
  }
  try {
    const outcome = await consumeStream(
      first.deploy(req),
      opts.sink,
      cursor,
      () => {
        started = true;
      },
    );
    if (outcome.terminal) return outcome.terminal;
    if (!started) {
      throw new AgentUnavailableError("agent stream produced no events");
    }
  } catch (e) {
    if (e instanceof AgentUnavailableError && !started) throw e;
    if (!started) {
      throw new AgentUnavailableError(
        e instanceof Error ? e.message : String(e),
      );
    }
    opts.sink.log(
      "warn",
      `Agent stream dropped (${e instanceof Error ? e.message : String(e)}); reconnecting…`,
    );
  } finally {
    first.close();
  }

  for (let attempt = 1; attempt <= REATTACH_MAX_TRIES; attempt++) {
    await delay(REATTACH_BACKOFF_MS * attempt);
    let conn: Awaited<ReturnType<typeof connectAgent>>;
    try {
      conn = await connectAgent(opts.serverId);
    } catch {
      continue;
    }
    try {
      opts.sink.log(
        "info",
        `Reattaching to deploy ${opts.deployId} (from #${cursor.seq})…`,
      );
      const outcome = await consumeStream(
        conn.reattach({ deployId: opts.deployId, fromSeq: cursor.seq }),
        opts.sink,
        cursor,
        () => {},
      );
      if (outcome.terminal) return outcome.terminal;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not.?found/i.test(msg)) {
        opts.sink.log(
          "error",
          `Agent has no record of deploy ${opts.deployId}; giving up.`,
        );
        return { ready: false, commitSha: "" };
      }
      opts.sink.log("warn", `Reattach attempt ${attempt} failed (${msg}).`);
    } finally {
      conn.close();
    }
  }
  opts.sink.log(
    "error",
    "Could not reconnect to the agent to follow the deploy.",
  );
  return { ready: false, commitSha: "" };
}

const REATTACH_MAX_TRIES = 5;
const REATTACH_BACKOFF_MS = 1_000;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function consumeStream(
  stream: AsyncGenerator<DeployEvent, void, unknown>,
  sink: AgentDeploySink,
  cursor: { seq: number },
  onFirst: () => void,
): Promise<{ terminal: AgentDeployResult | null }> {
  let sawAny = false;
  for await (const ev of stream) {
    if (!sawAny) {
      sawAny = true;
      onFirst();
    }
    const seq = Number(ev.seq ?? 0);
    if (seq && seq <= cursor.seq) continue;
    if (seq) cursor.seq = seq;
    const terminal = handleEvent(ev, sink);
    if (terminal !== undefined) {
      return {
        terminal: { ready: terminal.ready, commitSha: terminal.commitSha },
      };
    }
  }
  return { terminal: null };
}

export class AgentUnavailableError extends Error {}

function handleEvent(
  ev: DeployEvent,
  sink: AgentDeploySink,
): { ready: boolean; commitSha: string } | undefined {
  if (ev.log) {
    sink.log(coerceLevel(ev.log.level), ev.log.text);
    return undefined;
  }
  if (ev.phase) {
    sink.phase?.(ev.phase.phase);
    return undefined;
  }
  if (ev.result) {
    if (!ev.result.ready && ev.result.error) {
      sink.log("error", explainNetworkError(ev.result.error));
    }
    return { ready: ev.result.ready, commitSha: ev.result.commitSha || "" };
  }
  return undefined;
}

const LEVELS = new Set<LogLevel>([
  "info",
  "warn",
  "error",
  "debug",
  "command",
  "success",
]);
function coerceLevel(s: string): LogLevel {
  return LEVELS.has(s as LogLevel) ? (s as LogLevel) : "info";
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
  };

  if (opts.plan.kind === "compose") {
    return {
      ...base,
      sourceKind: SourceKind.SOURCE_KIND_COMPOSE,
      buildKind: BuildKind.BUILD_KIND_NONE,
      composeUpArgs: composeDeployArgs(opts.composeUpArgs ?? []),
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
      ...noProbeBuildFields(opts.plan.build, opts.env),
      git: {
        url: opts.plan.url,
        branch: opts.plan.branch,
        subdir: opts.plan.subdir,
        token: "",
      },
    };
  }

  const { buildDir, build } = opts.plan;
  const normalized = normalizeBuildConfig(build);
  const tar = await tarDir(buildDir);

  const heavyKind = heavyBuildKind(normalized.buildMethod);
  if (heavyKind !== null) {
    return {
      ...base,
      sourceKind: SourceKind.SOURCE_KIND_UPLOAD,
      buildKind: heavyKind,
      buildSpec: buildSpecFor(normalized),
      contextTar: tar,
    };
  }

  let dockerfile;
  if (normalized.buildMethod === "dockerfile") {
    dockerfile = explicitDockerfileDescriptor(normalized);
  } else {
    const hasDockerfile = await fileExists(join(buildDir, "Dockerfile"));
    dockerfile = hasDockerfile
      ? {
          dockerfilePath: "Dockerfile",
          contextPath: ".",
          targetStage: "",
          generated: false,
          generatedDockerfile: "",
        }
      : {
          dockerfilePath: "",
          contextPath: ".",
          targetStage: "",
          generated: true,
          generatedDockerfile: generateDockerfile(
            normalized,
            Object.keys(opts.env),
          ),
        };
  }

  return {
    ...base,
    sourceKind: SourceKind.SOURCE_KIND_UPLOAD,
    buildKind: BuildKind.BUILD_KIND_DOCKERFILE,
    dockerfile,
    contextTar: tar,
  };
}

function noProbeBuildFields(
  build: BuildConfig,
  env: Record<string, string>,
): Partial<DeployRequest> {
  const normalized = normalizeBuildConfig(build);
  const heavyKind = heavyBuildKind(normalized.buildMethod);
  if (heavyKind !== null) {
    return { buildKind: heavyKind, buildSpec: buildSpecFor(normalized) };
  }
  const dockerfile =
    normalized.buildMethod === "dockerfile"
      ? explicitDockerfileDescriptor(normalized)
      : {
          dockerfilePath: "",
          contextPath: ".",
          targetStage: "",
          generated: true,
          generatedDockerfile: generateDockerfile(normalized, Object.keys(env)),
        };
  return { buildKind: BuildKind.BUILD_KIND_DOCKERFILE, dockerfile };
}

function tarDir(dir: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["--format=ustar", "-cf", "-", "-C", dir, "."], {
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tar exited ${code} while archiving build context`));
        return;
      }
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
