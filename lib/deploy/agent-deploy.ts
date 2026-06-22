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
 * The agent-deploy seam (PLAN Part A, step 4). Every deploy EXECUTES on the
 * owning server's agent — there is no in-process Docker path. The control plane
 * still does policy, the Deployment row, source materialisation, compose
 * rendering (D2) and env decryption (D4) — then hands the agent a self-contained
 * DeployRequest and streams its events back into the existing log/status writes.
 *
 * The agent handles the **Dockerfile/auto build + single-image compose-up** path,
 * prebuilt images, git clones, dev-workspace builds, and multi-service compose
 * stacks. Build methods the agent can't yet run ({@link agentCanHandle} returns
 * false — Nixpacks/Buildpacks/Railpack/static) are a clear deploy ERROR, not a
 * fallback: there is no local path to fall back to. An unreachable/unavailable
 * agent is likewise a hard deploy failure (P5), never a silent local rebuild.
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
    }
  | {
      /**
       * The agent clones a git repo ITSELF (D3, Part B) — used for a REMOTE
       * server so the whole repo never crosses the wire, only the descriptor.
       * The control plane has already resolved the authenticated clone URL (a
       * short-lived token baked in for private GitHub) and the branch + subdir.
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
       * A multi-service compose stack (Part C). The control plane already
       * rendered the full stack (buildComposeStack) into `composeYaml` and
       * decrypted the env (`env`); the agent neither builds nor pulls an image
       * (each service's image comes up via `docker compose up`). It writes the
       * env to a 0600 --env-file (the YAML interpolates `${VAR}`), materialises
       * these `mounts` (template config files) under its files dir, then brings
       * the stack up and waits for it by the deplo.slug label.
       */
      kind: "compose";
      /** Template config files the stack bind-mounts (project.mounts); may be empty. */
      mounts: { filePath: string; content: string }[];
    }
  | {
      /**
       * "Deploy from dev workspace" on a REMOTE server (Part D). The developer's
       * live tree lives on the AGENT's host (<dev-dir>/<slug>), so the control
       * plane never copies it — the agent builds from its OWN workspace
       * (SOURCE_KIND_DEV_WORKSPACE), applying the same exclude-set + symlink-reject
       * guard copyWorkspaceForBuild does on localhost. No workspace bytes cross the
       * wire. The build dispatch mirrors the git arm (no tree to probe here).
       */
      kind: "dev-workspace";
      /** Build config (drives the Dockerfile dispatch, same as the git plan). */
      build: BuildConfig;
      /** rootDirectory within the workspace (validated against the build dir on
       *  the agent). Mirrors the git plan's subdir. */
      subdir: string;
    };

/**
 * Whether the agent can execute this deploy in Part A. The agent owns only the
 * Dockerfile-family build (an explicit Dockerfile, or the generated/auto Node
 * Dockerfile) and running a prebuilt image. The heavier builders stay local.
 */
export function agentCanHandle(build: BuildConfig | null): boolean {
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

/** The outcome of an agent deploy: readiness + any commit sha the agent resolved. */
export interface AgentDeployResult {
  ready: boolean;
  /** Set when the agent materialised a GIT source and resolved the commit. */
  commitSha: string;
}

/**
 * Run a deploy through the agent. Performs the mandatory Hello pre-flight (P5),
 * builds the DeployRequest (taring the context for a Dockerfile/upload build, a
 * GIT source the agent clones itself, a dev-workspace, or an IMAGE source),
 * streams events into `sink`, and resolves `ready: true` on a ready result.
 * Throws {@link AgentUnavailableError} on agent-unreachable / transport errors
 * BEFORE any work began (the caller turns it into a hard deploy failure — there
 * is no local fallback); returns `ready: false` on a clean BUILD failure reported
 * by the agent (the deploy genuinely failed).
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
}): Promise<AgentDeployResult> {
  // P5: fail fast if the agent doesn't answer, rather than hanging a deploy.
  const hello = await agentPreflight(opts.serverId);
  if (!hello.dockerAvailable) {
    throw new AgentUnavailableError(
      "the agent reports Docker is not available on the target server",
    );
  }

  const req = await buildDeployRequest(opts);

  // Cursor: the highest seq we've successfully consumed. A reattach asks the
  // agent to replay everything AFTER this, so a reconnect never double-logs and
  // never misses an event (D5). Shared across the initial Deploy and any reattach.
  const cursor = { seq: 0 };

  // First leg: the Deploy stream. `started` gates fallback — once the agent has
  // begun real work, a local fallback would DOUBLE-build, so from here a failure
  // is a deploy ERROR (or a RECONNECT), never a silent local rebuild.
  let started = false;
  const first = await connectAgent(opts.serverId);
  try {
    const outcome = await consumeStream(first.deploy(req), opts.sink, cursor, () => {
      started = true;
    });
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
      throw new AgentUnavailableError(e instanceof Error ? e.message : String(e));
    }
    opts.sink.log(
      "warn",
      `Agent stream dropped (${e instanceof Error ? e.message : String(e)}); reconnecting…`,
    );
  } finally {
    first.close();
  }

  // RECONNECT/REPLAY (D5). The agent kept building through the drop and buffered
  // its events; reattach by deploy id, replaying from our cursor, and follow it
  // to completion. Bounded retries with backoff — if the agent is genuinely gone
  // (or has no record of the deploy), give up and mark the deploy errored rather
  // than hang or double-build.
  for (let attempt = 1; attempt <= REATTACH_MAX_TRIES; attempt++) {
    await delay(REATTACH_BACKOFF_MS * attempt);
    let conn: Awaited<ReturnType<typeof connectAgent>>;
    try {
      conn = await connectAgent(opts.serverId);
    } catch {
      continue; // agent not back yet; retry
    }
    try {
      opts.sink.log("info", `Reattaching to deploy ${opts.deployId} (from #${cursor.seq})…`);
      const outcome = await consumeStream(
        conn.reattach({ deployId: opts.deployId, fromSeq: cursor.seq }),
        opts.sink,
        cursor,
        () => {},
      );
      if (outcome.terminal) return outcome.terminal;
      // Stream ended without a terminal result: the agent is still building (a
      // partial replay) — loop to reattach again from the advanced cursor.
    } catch (e) {
      // NOT_FOUND => the agent has no record (never ran it, or it was evicted):
      // unrecoverable, stop retrying.
      const msg = e instanceof Error ? e.message : String(e);
      if (/not.?found/i.test(msg)) {
        opts.sink.log("error", `Agent has no record of deploy ${opts.deployId}; giving up.`);
        return { ready: false, commitSha: "" };
      }
      opts.sink.log("warn", `Reattach attempt ${attempt} failed (${msg}).`);
    } finally {
      conn.close();
    }
  }
  opts.sink.log("error", "Could not reconnect to the agent to follow the deploy.");
  return { ready: false, commitSha: "" };
}

const REATTACH_MAX_TRIES = 5;
const REATTACH_BACKOFF_MS = 1_000;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Consume one event stream (Deploy or Reattach) into the sink, advancing the
 * shared seq cursor and calling `onFirst` on the first event. Returns the
 * terminal result if one arrived, or `{ terminal: null }` if the stream ended
 * (cleanly or via the generator returning) without one. Throws on a transport
 * error so the caller can decide to reattach.
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
      return { terminal: { ready: terminal.ready, commitSha: terminal.commitSha } };
    }
  }
  return { terminal: null };
}

/**
 * An agent transport/availability failure BEFORE any deploy work began. There is
 * no local fallback, so the caller turns this into a hard deploy failure (P5); it
 * exists separately from a normal error only so {@link runAgentDeploy} can tell
 * "the agent never started" (fail the deploy) from "the stream dropped mid-build"
 * (reattach + replay), never double-building over an in-flight agent deploy.
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
    mounts: [],
    devWorkspaceSubdir: "",
  };

  if (opts.plan.kind === "compose") {
    // A multi-service compose stack (Part C): no build, no image pull — the agent
    // writes the env to a --env-file (the YAML interpolates `${VAR}`), the mount
    // files under its files dir, then `docker compose up`s the rendered stack and
    // waits for it by the deplo.slug label. composeYaml + env ride in `base`.
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
      // The local docker-image path ALWAYS pulls (build.ts streamDocker "pull"),
      // so the agent always pulls too — exact parity. A docker-image source is a
      // registry ref by definition; pulling refreshes a moved tag and surfaces a
      // missing image as a clear pull error instead of running a stale local one.
      pullImage: true,
    };
  }

  if (opts.plan.kind === "git") {
    // GIT source (D3): the agent clones the repo itself, so no context is tarred
    // here — only the descriptor crosses the wire. We can't probe the (not-yet-
    // cloned) tree for a root Dockerfile, so for the generated/auto method we
    // send generated:true with the body; the agent's buildImage writes it ONLY
    // when the clone has no Dockerfile — the same prefer-repo-Dockerfile
    // semantics as the local buildGenerated path, decided where the tree lives.
    const normalized = normalizeBuildConfig(opts.plan.build);
    const dockerfile =
      normalized.buildMethod === "dockerfile"
        ? explicitDockerfileDescriptor(normalized)
        : {
            dockerfilePath: "",
            contextPath: ".",
            targetStage: "",
            generated: true,
            generatedDockerfile: generateDockerfile(normalized),
          };
    return {
      ...base,
      sourceKind: SourceKind.SOURCE_KIND_GIT,
      buildKind: BuildKind.BUILD_KIND_DOCKERFILE,
      dockerfile,
      git: {
        url: opts.plan.url,
        branch: opts.plan.branch,
        subdir: opts.plan.subdir,
        token: "", // the url is already authenticated by the control plane
      },
    };
  }

  if (opts.plan.kind === "dev-workspace") {
    // DEV_WORKSPACE source (Part D, remote): the agent builds from its OWN
    // <dev-dir>/<slug> (no tree crosses the wire). Like the git arm, we can't
    // probe the not-here tree for a root Dockerfile, so for the generated/auto
    // method we send generated:true with the body; the agent's buildImage writes
    // it ONLY when the workspace has no Dockerfile — same prefer-repo-Dockerfile
    // semantics as the local copyWorkspaceForBuild + buildGenerated path.
    const normalized = normalizeBuildConfig(opts.plan.build);
    const dockerfile =
      normalized.buildMethod === "dockerfile"
        ? explicitDockerfileDescriptor(normalized)
        : {
            dockerfilePath: "",
            contextPath: ".",
            targetStage: "",
            generated: true,
            generatedDockerfile: generateDockerfile(normalized),
          };
    return {
      ...base,
      sourceKind: SourceKind.SOURCE_KIND_DEV_WORKSPACE,
      buildKind: BuildKind.BUILD_KIND_DOCKERFILE,
      dockerfile,
      devWorkspaceSubdir: opts.plan.subdir,
    };
  }

  // Dockerfile build from a materialised local context (UPLOAD). The dispatch
  // MUST mirror lib/deploy/builders.ts so the agent builds byte-identically to
  // the old local path:
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
