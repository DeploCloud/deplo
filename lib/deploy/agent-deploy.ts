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
} from "../agent/gen/agent";
import { connectAgent, agentPreflight } from "../infra/agent-client";
import { generateDockerfile } from "./dockerfile";
import { normalizeBuildConfig } from "../frameworks";
import type { BuildConfig, LogLevel } from "../types";

/**
 * The agent-deploy seam (PLAN Part A, step 4). This is where `runDeployment`'s
 * EXECUTION moves off the direct-Docker path and onto the agent: the control
 * plane still does policy, the Deployment row, source materialisation, compose
 * rendering (D2) and env decryption (D4) — then hands the agent a self-contained
 * DeployRequest and streams its events back into the existing log/status writes.
 *
 * PART A SCOPE — the agent handles the **Dockerfile build + single-image
 * compose-up** path (the most common). Everything else (Nixpacks/Buildpacks/
 * Railpack/static builders, multi-service compose stacks) stays on today's local
 * path via {@link agentCanHandle} returning false, so there is ZERO behavioural
 * change for those. If the agent is unreachable/unavailable, the caller also
 * falls back — the local path is never removed in Part A, only bypassed when the
 * agent can do the job.
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
      /** The agent runs a prebuilt image as-is (source: docker-image). */
      kind: "image";
      image: string;
    };

/**
 * Whether the agent can execute this deploy in Part A. The agent owns only the
 * Dockerfile-family build (an explicit Dockerfile, or the generated/auto Node
 * Dockerfile) and running a prebuilt image. The heavier builders stay local.
 */
export function agentCanHandle(build: BuildConfig | null): boolean {
  if (process.env.DEPLO_AGENT_DEPLOY === "off") return false;
  if (!build) return true; // image source: no build config involved
  const method = normalizeBuildConfig(build).buildMethod;
  // "dockerfile" is explicit; an unknown/legacy method funnels to the generated
  // Dockerfile path (buildGenerated), which the agent also supports. The named
  // heavy builders do NOT.
  return method === "dockerfile" || !KNOWN_HEAVY.has(method);
}

const KNOWN_HEAVY = new Set(["railpack", "nixpacks", "heroku", "paketo", "static"]);

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
 * to the old local path. Honours the project's `methodSettings`
 * (dockerfilePath / dockerContextPath / dockerBuildStage) with the SAME defaults
 * — dropping these silently shipped the wrong image (a multi-stage build's last
 * stage instead of the chosen `--target`, or a generated Dockerfile in place of a
 * custom path). Pure (no I/O) so the parity contract is unit-tested directly.
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

/** Callbacks the agent stream writes into — the existing deploy log/status seam. */
export interface AgentDeploySink {
  log: (level: LogLevel, text: string) => void;
  /** Called on each phase transition (for future status granularity). */
  phase?: (phase: DeployPhase) => void;
}

/**
 * Run a deploy through the agent. Performs the mandatory Hello pre-flight (P5),
 * builds the DeployRequest (taring the context for a Dockerfile build, or an
 * IMAGE source), streams events into `sink`, and resolves true on a ready
 * result. Throws on agent-unreachable / transport errors so the caller can fall
 * back to the local path; returns false on a clean BUILD failure reported by the
 * agent (the deploy genuinely failed — do NOT silently retry locally).
 */
export async function runAgentDeploy(opts: {
  serverId: string;
  deployId: string;
  slug: string;
  projectId: string;
  imageRef: string;
  composeYaml: string;
  env: Record<string, string>;
  plan: AgentBuildPlan;
  readyTimeoutMs?: number;
  sink: AgentDeploySink;
}): Promise<boolean> {
  // P5: fail fast if the agent doesn't answer, rather than hanging a deploy.
  const hello = await agentPreflight(opts.serverId);
  if (!hello.dockerAvailable) {
    throw new AgentUnavailableError(
      "the agent reports Docker is not available on the target server",
    );
  }

  const req = await buildDeployRequest(opts);
  const conn = await connectAgent(opts.serverId);
  // Track whether the agent has started doing real work. Once it has (any
  // event received, or the stream errors mid-flight), a local fallback would
  // DOUBLE-build and thrash the container the agent may have already brought up
  // — so past this point a failure is a deploy ERROR, not a fallback. Falling
  // back is only safe BEFORE any work began (a pure connect/transport failure).
  let started = false;
  try {
    for await (const ev of conn.deploy(req)) {
      started = true;
      const result = handleEvent(ev, opts.sink);
      if (result !== undefined) return result;
    }
    // Stream ended cleanly but with no terminal result. If work had begun, the
    // agent's state is unknown — fail rather than silently rebuilding locally.
    if (started) {
      opts.sink.log("error", "Agent stream ended without a result.");
      return false;
    }
    throw new AgentUnavailableError("agent stream produced no events");
  } catch (e) {
    if (e instanceof AgentUnavailableError) throw e;
    // A mid-stream transport error AFTER work began: do not fall back (Part A is
    // fire-and-forget — reconnect/replay is Part B). Surface it as a deploy
    // failure so we never double-build over an in-flight agent deploy.
    if (started) {
      opts.sink.log(
        "error",
        `Agent deploy interrupted: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
    // Failure before any work began == agent unavailable: safe to fall back.
    throw new AgentUnavailableError(
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    conn.close();
  }
}

/**
 * An agent transport/availability failure BEFORE any deploy work began — the
 * caller may safely fall back to the local path (the agent did nothing). A
 * failure AFTER work began is NOT this error: it is reported as a deploy failure
 * so we never double-build over an in-flight agent deploy.
 */
export class AgentUnavailableError extends Error {}

/** Translate one DeployEvent into the sink; return a boolean only for the
 * terminal result, else undefined. */
function handleEvent(
  ev: DeployEvent,
  sink: AgentDeploySink,
): boolean | undefined {
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
    return ev.result.ready;
  }
  return undefined;
}

const LEVELS = new Set<LogLevel>(["info", "warn", "error", "debug", "command"]);
function coerceLevel(s: string): LogLevel {
  return LEVELS.has(s as LogLevel) ? (s as LogLevel) : "info";
}

/** Build the self-contained DeployRequest the agent needs. */
async function buildDeployRequest(opts: {
  deployId: string;
  slug: string;
  projectId: string;
  imageRef: string;
  composeYaml: string;
  env: Record<string, string>;
  plan: AgentBuildPlan;
  readyTimeoutMs?: number;
}): Promise<DeployRequest> {
  const base: DeployRequest = {
    deployId: opts.deployId,
    slug: opts.slug,
    projectId: opts.projectId,
    imageRef: opts.imageRef,
    sourceKind: SourceKind.SOURCE_KIND_UNSPECIFIED,
    buildKind: BuildKind.BUILD_KIND_UNSPECIFIED,
    dockerfile: undefined,
    composeYaml: opts.composeYaml,
    env: opts.env,
    readyTimeoutMs: opts.readyTimeoutMs ?? 60_000,
    contextTar: new Uint8Array(0),
    pullImage: false,
  };

  if (opts.plan.kind === "image") {
    return {
      ...base,
      sourceKind: SourceKind.SOURCE_KIND_IMAGE,
      buildKind: BuildKind.BUILD_KIND_NONE,
      // The local docker-image path ALWAYS pulls (build.ts streamDocker "pull"),
      // so the agent always pulls too — exact parity. A docker-image source is a
      // registry ref by definition; pulling refreshes a moved tag and surfaces a
      // missing image as a clear pull error instead of running a stale local one.
      pullImage: true,
    };
  }

  // Dockerfile build. The dispatch MUST mirror lib/deploy/builders.ts so the
  // agent builds byte-identically to the old local path:
  //   - buildMethod "dockerfile" → buildFromDockerfile: honour the explicit
  //     dockerfilePath / dockerContextPath / dockerBuildStage from methodSettings;
  //     the Dockerfile is REQUIRED (the agent errors loudly if it is missing),
  //     and a generated Dockerfile is NEVER substituted.
  //   - anything else (the legacy/auto method agentCanHandle also allows) →
  //     buildGenerated: build the repo's root Dockerfile if present, else build a
  //     control-plane-generated one.
  const { buildDir, build } = opts.plan;
  const normalized = normalizeBuildConfig(build);
  const tar = await tarDir(buildDir);

  let dockerfile;
  if (normalized.buildMethod === "dockerfile") {
    dockerfile = explicitDockerfileDescriptor(normalized);
  } else {
    // Legacy/auto: prefer a root Dockerfile, else generate one — exactly as
    // buildGenerated does (builders.ts:168-181). The control plane renders the
    // generated Dockerfile (single source of truth for framework presets); the
    // agent only writes + builds it.
    const hasDockerfile = await fileExists(join(buildDir, "Dockerfile"));
    dockerfile = hasDockerfile
      ? { dockerfilePath: "Dockerfile", contextPath: ".", targetStage: "", generated: false, generatedDockerfile: "" }
      : {
          dockerfilePath: "",
          contextPath: ".",
          targetStage: "",
          generated: true,
          generatedDockerfile: generateDockerfile(normalized),
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
 * Tar a directory into memory (the streamed build context). Uses the host `tar`
 * binary the control plane already depends on for archive handling — emits a
 * deterministic, relative-path archive the agent extracts with its anti-escape
 * guard. `--format=ustar` keeps entries plain (no GNU/pax extensions the Go
 * archive/tar reader treats specially).
 *
 * NO exclusions: the context must byte-match what the LOCAL path's `docker build
 * <buildDir>` would send to the daemon, so the agent build is parity-identical
 * (a Dockerfile's `.dockerignore` still applies on the agent's `docker build`,
 * exactly as it does locally — the place to drop files is the repo's own
 * `.dockerignore`, not here, where it would silently differ from the local path).
 */
function tarDir(dir: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "tar",
      ["--format=ustar", "-cf", "-", "-C", dir, "."],
      { windowsHide: true },
    );
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
