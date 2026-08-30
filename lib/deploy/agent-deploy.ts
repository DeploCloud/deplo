// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// https://deplo.build/docs/concepts/servers-and-the-agent

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
import { connectAgent, agentPreflight } from "../infra/agent-client";
import { loadRegistryAuthsForApp } from "../data/registries";
import { generateDockerfile } from "./dockerfile";
import {
  normalizeBuildConfig,
  DEFAULT_NODE_MAJOR,
  usesDefaultNodeMajor,
} from "../frameworks";
import type { BuildConfig, BuildMethod, LogLevel } from "../types";

/**
 * The agent-deploy seam (PLAN Part A, step 4). An unreachable/unavailable agent is
 * likewise a hard deploy failure (P5), never a silent local rebuild.
 */

/** A built-context source the agent can tar up and build, vs. an image to run. */
export type AgentBuildPlan =
  | {
      /** The agent builds a Dockerfile from a materialised context dir. */
      kind: "dockerfile";
      /** Absolute dir the control plane resolved (rootDirectory already applied). */
      buildDir: string;
      /** Build config (for the generated-Dockerfile fallback + method check). */
      build: BuildConfig;
    }
  | {
      /** The agent runs an already-existing image as-is - no build. */
      kind: "image";
      image: string;
      /**
       * Whether the agent must `docker pull` it first.
       */
      pull: boolean;
    }
  | {
      /**
       * The agent clones a git repo ITSELF (D3, Part B) - used for a REMOTE server
       * so the whole repo never crosses the wire, only the descriptor.
       */
      kind: "git";
      url: string;
      branch: string;
      /** rootDirectory within the repo (validated against the clone on the agent). */
      subdir: string;
      /** Build config (drives the Dockerfile dispatch, same as the dockerfile plan). */
      build: BuildConfig;
    }
  | {
      /**
       * A multi-service compose stack (Part C).
       */
      kind: "compose";
      /** Template config files the stack bind-mounts (project.mounts); may be empty. */
      mounts: { filePath: string; content: string }[];
    };

/**
 * Whether the agent can execute this build method at all. So this is always true;
 * it stays as the single predicate the deploy arms call so a future
 * agent-only-can't-do-X method has one place to return false.
 */
export function agentCanHandle(build: BuildConfig | null): boolean {
  if (!build) return true; // image source: no build config involved
  void normalizeBuildConfig(build).buildMethod; // every known method is handled
  return true;
}

/** The heavy build methods, mapped to the agent BuildKind that runs them and the
 * Hello capability a server's agent must advertise to be sent that kind. A method
 * absent here is the Dockerfile family (explicit or generated/auto). */
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

/**
 * The agent capability a build method requires, or null for the Dockerfile family
 * (always supported via the base deploy.dockerfile capability).
 */
export function agentCapabilityForMethod(
  build: BuildConfig | null,
): string | null {
  if (!build) return null;
  return (
    HEAVY_METHOD[normalizeBuildConfig(build).buildMethod]?.capability ?? null
  );
}

/** The heavy BuildKind for a method, or null for the Dockerfile family (which uses
 * BUILD_KIND_DOCKERFILE + a DockerfileDescriptor instead of a BuildSpec). */
function heavyBuildKind(method: BuildMethod): BuildKind | null {
  return HEAVY_METHOD[method]?.kind ?? null;
}

/**
 * The BuildSpec the agent's heavy builders read - flattens BuildConfig +
 * methodSettings onto the wire.
 */
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
    runtimeVersion,
    runtimeLanguage: runtimeVersion ? "node" : "",
    nixpacksPublishDirectory:
      b.methodSettings.nixpacksPublishDirectory?.trim() ?? "",
    herokuVersion: "",
    railpackVersion: b.methodSettings.railpackVersion?.trim() ?? "",
    staticSinglePageApp: b.methodSettings.staticSinglePageApp ?? false,
  };
}

/** The proto DockerfileBuild shape the agent receives. */
export interface DockerfileDescriptor {
  dockerfilePath: string;
  contextPath: string;
  targetStage: string;
  generated: boolean;
  generatedDockerfile: string;
}

/**
 * The Dockerfile descriptor for the EXPLICIT "dockerfile" build method, mirroring
 * lib/deploy/builders.ts buildFromDockerfile so the agent builds byte-identically
 * to the old local path.
 */
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

/** Callbacks the agent stream writes into - the existing deploy log/status seam. */
export interface AgentDeploySink {
  log: (level: LogLevel, text: string) => void;
  /** Called on each phase transition (for future status granularity). */
  phase?: (phase: DeployPhase) => void;
}

/** The outcome of an agent deploy: readiness + any commit sha the agent resolved. */
export interface AgentDeployResult {
  ready: boolean;
  /** Set when the agent materialised a GIT source and resolved the commit. */
  commitSha: string;
}

/**
 * Run a deploy through the agent.
 */
export async function runAgentDeploy(opts: {
  serverId: string;
  deployId: string;
  slug: string;
  appId: string;
  imageRef: string;
  composeYaml: string;
  /** The stack's own Docker network - its Environment's, its team's, or a
   *  preview's. The agent creates it and puts Traefik on it. */
  network: string;
  env: Record<string, string>;
  plan: AgentBuildPlan;
  readyTimeoutMs?: number;
  /** Build with `--no-cache` (the app's Build cache is off, or a clear is armed). */
  noCache?: boolean;
  /** `compose up --force-recreate` - the explicit "Rebuild container" action. */
  forceRecreate?: boolean;
  /** The app's extra `docker compose up` flags, already split into argv tokens. */
  composeUpArgs?: string[];
  /** This host is a BUILD SERVER: build the image and stop. */
  buildOnly?: boolean;
  sink: AgentDeploySink;
}): Promise<AgentDeployResult> {
  // P5: fail fast if the agent doesn't answer, rather than hanging a deploy.
  const hello = await agentPreflight(opts.serverId);
  if (!hello.dockerAvailable) {
    throw new AgentUnavailableError(
      "the agent reports Docker is not available on the target server",
    );
  }
  // A HARD gate, unlike the three soft ones below, and the difference is what
  // ignoring the field would do: an older agent reads `build_only` as absent and
  // DEPLOYS the app here - quietly running production on the build server.
  if (opts.buildOnly && !hello.capabilities.includes("deploy.build-only")) {
    throw new AgentUnavailableError(
      "this build server's agent is too old to build without deploying - update it " +
        "from Settings → Servers, or build this app on its own server",
    );
  }
  // Both freshness switches are additive wire fields: an agent that predates them
  // ignores the field and quietly does the cached / non-recreating thing.
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
  // Same reasoning, louder: extra compose flags are a deliberate instruction, so
  // an agent that drops them is running a DIFFERENT command than the settings
  // page shows. Say which flags went missing, not just that some did.
  if (
    opts.composeUpArgs?.length &&
    !hello.capabilities.includes("deploy.compose-args")
  ) {
    opts.sink.log(
      "warn",
      `This server's agent is too old to apply this app's extra compose flags (${opts.composeUpArgs.join(" ")}) - ` +
        "it is bringing the stack up without them. Update the agent (reissue the install " +
        "command from the server's actions menu).",
    );
  }

  const req = await buildDeployRequest({
    ...opts,
    // The team's registry credentials: every pull the agent makes for this deploy
    // authenticates with them (image ref, compose images, a Dockerfile's base).
    registryAuth: await loadRegistryAuthsForApp(opts.appId),
  });

  // Cursor: the highest seq we've successfully consumed. A reattach asks the
  // agent to replay everything AFTER this, so a reconnect never double-logs and
  // never misses an event (D5). Shared across the initial Deploy and any reattach.
  const cursor = { seq: 0 };

  // First leg: the Deploy stream. `started` gates fallback - once the agent has
  // begun real work, a local fallback would DOUBLE-build, so from here a failure
  // is a deploy ERROR (or a RECONNECT), never a silent local rebuild.
  let started = false;
  const first = await connectAgent(opts.serverId);
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
      // No events at all == agent unavailable: safe to fall back to local.
      throw new AgentUnavailableError("agent stream produced no events");
    }
    // Dropped/ended without a result after work began: reattach below.
  } catch (e) {
    if (e instanceof AgentUnavailableError && !started) throw e;
    if (!started) {
      // Pure connect/transport failure before any work: agent unavailable.
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

  // RECONNECT/REPLAY (D5).
  for (let attempt = 1; attempt <= REATTACH_MAX_TRIES; attempt++) {
    await delay(REATTACH_BACKOFF_MS * attempt);
    let conn: Awaited<ReturnType<typeof connectAgent>>;
    try {
      conn = await connectAgent(opts.serverId);
    } catch {
      continue; // agent not back yet; retry
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
      // Stream ended without a terminal result: the agent is still building (a
      // partial replay) - loop to reattach again from the advanced cursor.
    } catch (e) {
      // NOT_FOUND => the agent has no record (never ran it, or it was evicted):
      // unrecoverable, stop retrying.
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

/**
 * Consume one event stream (Deploy or Reattach) into the sink, advancing the
 * shared seq cursor and calling `onFirst` on the first event.
 */
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
    // Skip anything at or below the cursor (a replay overlap), then advance it.
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

/**
 * An agent transport/availability failure BEFORE any deploy work began.
 */
export class AgentUnavailableError extends Error {}

/** Translate one DeployEvent into the sink; return the terminal result (ready +
 * commit sha) only for the result event, else undefined. */
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
      sink.log("error", ev.result.error);
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

/** Build the self-contained DeployRequest the agent needs. Exported for tests:
 * the plan→request mapping (source/build kind, env-file vs baked env, mounts) is
 * the wire contract with the Go agent and is asserted directly. */
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
  /** The app's extra `docker compose up` flags, already split into argv tokens
   *  (lib/deploy/compose-args.ts). Empty for every app that never set any. */
  composeUpArgs?: string[];
  /** Build the image and stop - this host is a BUILD SERVER and runs nothing of
   *  the app. The caller then streams the image to the host that does. */
  buildOnly?: boolean;
  /** Decrypted registry credentials for this deploy's pulls (loadRegistryAuthsForApp). */
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
    // Dead V1 wire field (dev mode removed); the generated type still requires it.
    devWorkspaceSubdir: "",
    buildSpec: undefined,
    // Freshness switches, both default-off so an ordinary deploy's request is
    // byte-identical to what it always was.
    noBuildCache: opts.noCache ?? false,
    forceRecreate: opts.forceRecreate ?? false,
    // Appended to the bring-up the AGENT assembles - the project name, stack file
    // and env-file are never ours to send. Empty for almost every app.
    composeUpArgs: opts.composeUpArgs ?? [],
    // Stop after the build: nothing of this app is written to the stack dir and nothing
    // is brought up here.
    buildOnly: opts.buildOnly ?? false,
    // Empty for a team that connected no registry, which leaves the host's own
    // docker config untouched.
    registryAuth: opts.registryAuth ?? [],
  };

  if (opts.plan.kind === "compose") {
    // A multi-service compose stack (Part C): no build, no image pull - the agent
    // writes the env to a --env-file (the YAML interpolates `${VAR}`), the mount files
    // under its files dir, then `docker compose up`s the rendered stack and waits for
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
      // The plan decides - see `pull` on the image arm of AgentBuildPlan. A docker-image
      // source pulls (parity with the old local path, which always did); a rollback must
      // not, because its image is local to that host and exists in no registry.
      pullImage: opts.plan.pull,
    };
  }

  if (opts.plan.kind === "git") {
    // GIT source (D3): the agent clones the repo itself, so no context is tarred here -
    // only the descriptor crosses the wire.
    return {
      ...base,
      sourceKind: SourceKind.SOURCE_KIND_GIT,
      ...noProbeBuildFields(opts.plan.build, opts.env),
      git: {
        url: opts.plan.url,
        branch: opts.plan.branch,
        subdir: opts.plan.subdir,
        token: "", // the url is already authenticated by the control plane
      },
    };
  }

  // Materialised local context (UPLOAD). - "dockerfile" → buildFromDockerfile: honour
  // the explicit dockerfilePath / dockerContextPath / dockerBuildStage; the
  // Dockerfile is REQUIRED, never substituted with a generated one.
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
    // Legacy/auto: prefer a root Dockerfile, else generate one - exactly as
    // buildGenerated does (builders.ts:168-181).
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

/**
 * The build-dispatch fields (buildKind + dockerfile|buildSpec) for a source whose
 * tree the control plane CANNOT probe here (a git clone materialises on the
 * agent).
 */
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

/**
 * Tar a directory into memory (the streamed build context).
 */
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
