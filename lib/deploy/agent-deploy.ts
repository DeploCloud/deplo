import "server-only";

import {
  BuildKind,
  DeployPhase,
  type DeployRequest,
  type DeployEvent,
  ReadyCheck,
  type SourceCompose,
} from "../agent/gen/agent";
import { explainNetworkError } from "./network";
import { status as GrpcStatus } from "@grpc/grpc-js";
import { connectAgent } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { agentPreflight } from "../infra/agent-client/preflight";
import {
  DEPLOY_PULL_BASE_CAPABILITY,
  FILES_BIND_CHECK_CAPABILITY,
  RESTART_CAPABILITY,
  START_AFTER_READY_CAPABILITY,
  SPREAD_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import {
  buildDeployRequest,
  type AgentBuildPlan,
} from "./agent-deploy-request";
import { stackFilesDir, stackName } from "./deploy-key";
import { fileBindsUnderFilesDir } from "./file-binds";
import { loadRegistryAuthsForApp } from "../data/registries";
import { restartRuleForApp } from "./restart-rule-app";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  apps as appsTable,
  appVolumes as appVolumesTable,
} from "../db/schema/control-plane/apps";
import { loadAppConnectorToken } from "../data/clusters/app-tunnel";
import { appConnectorService, withAppConnector } from "./app-connector";
import { tarDir, tarDirChunks } from "./context-tar";
import { offerBuiltImage } from "./build/build-reuse";
import { deployOverlap, type OverlapStacks } from "./overlap";
import { REPLICAS_AGENT_MESSAGE, REPLICAS_CAPABILITY } from "./replicas";
import { getServerById } from "../data/servers/roster";
import { offerFailoverBundle } from "./failover-offer";
import type { LogLevel } from "../types/deployment";

export interface AgentDeploySink {
  log: (level: LogLevel, text: string) => void;
  phase?: (phase: DeployPhase) => void;
}

export interface AgentDeployResult {
  ready: boolean;
  commitSha: string;
  // The agent's own reason for a failure, already in the log.
  error?: string;
  // The app listened here instead of the checked port.
  observedPort?: number;
  builtWith?: string;
  // The compose file the source turned out to carry: render it and deploy it as a stack.
  sourceCompose?: SourceCompose;
  listeningPorts?: number[];
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
  pullBase?: boolean;
  forceRecreate?: boolean;
  composeUpArgs?: string[];
  buildOnly?: boolean;
  forkPreview?: boolean;
  ready?: ReadyCheck;
  githubToken?: string;
  overlap?: OverlapStacks;
  // The deployment row of a git build that may take on an earlier image of the same commit.
  reuseFor?: string;
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
  // A HARD gate: an older agent ignores `commit` and would ship the branch tip (a rollback, an approved fork commit).
  if (
    opts.plan.kind === "git" &&
    opts.plan.commit &&
    !hello.capabilities.includes("git.commit")
  ) {
    throw new AgentUnavailableError(
      "this server's agent is too old to build a specific commit - update it " +
        "from Settings → Servers",
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
    opts.pullBase &&
    !hello.capabilities.includes(DEPLOY_PULL_BASE_CAPABILITY)
  ) {
    opts.sink.log(
      "warn",
      "This server's agent is too old to fetch a fresh base image - this build may reuse " +
        "the copy already on the server. Deplo updates the agent on its own.",
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
  applyAgentFeatures(req, opts, hello.capabilities, opts.sink);
  if (!opts.buildOnly && hello.capabilities.includes(RESTART_CAPABILITY))
    req.restartRule =
      (await restartRuleForApp(opts.appId, opts.ready)) ?? undefined;
  if (opts.overlap && !opts.buildOnly) {
    const replicas = opts.overlap.replicas;
    const scaled = opts.overlap.scaled === true;
    if (
      (replicas > 1 && !hello.capabilities.includes(REPLICAS_CAPABILITY)) ||
      (scaled && !hello.capabilities.includes(SPREAD_CAPABILITY))
    )
      throw new Error(REPLICAS_AGENT_MESSAGE);
    const choice = deployOverlap({
      ports: opts.overlap.ports,
      capabilities: hello.capabilities,
      dockerVersion: (await getServerById(opts.serverId))?.dockerVersion,
    });
    if (choice.overlap) {
      req.composeYaml = opts.overlap.live;
      req.standInComposeYaml = opts.overlap.standIn;
    } else if (replicas > 1 || scaled) {
      throw new Error(
        `Running ${scaled ? "replicas on several servers" : `${replicas} copies`} needs the new version to start beside the old one. ${choice.reason}`,
      );
    } else opts.sink.log("info", choice.reason);
  }
  const connectorToken = opts.buildOnly
    ? null
    : await appConnectorToken(opts.appId, opts.slug);
  if (connectorToken) {
    // A HARD gate: an older agent starts it at once, and the tunnel would send visitors to an App that is not up.
    if (!hello.capabilities.includes(START_AFTER_READY_CAPABILITY))
      throw new AgentUnavailableError(
        "this server's agent is too old to start the App's tunnel once it is ready - " +
          "Deplo updates the agent on its own",
      );
    req.composeYaml = withAppConnector(
      req.composeYaml,
      opts.slug,
      connectorToken,
    );
    req.startAfterReady = [appConnectorService(opts.slug)];
  }
  if (opts.reuseFor)
    req.reuseImage = await offerBuiltImage(
      opts.reuseFor,
      opts.serverId,
      req,
      hello.capabilities,
    );
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
  if (
    req.filesBindSources.length &&
    !hello.capabilities.includes(FILES_BIND_CHECK_CAPABILITY)
  ) {
    opts.sink.log(
      "warn",
      "This server's agent is too old to check this app's Files for links that lead outside them. " +
        "Update the agent (reissue the install command from the server's actions menu).",
    );
  }

  // A cluster App's leader gets what this deploy sent, sealed, once it is ready (ADR-0045).
  const offerBundle = (r: AgentDeployResult): AgentDeployResult => {
    if (r.ready && !opts.buildOnly && !opts.forkPreview)
      offerFailoverBundle(
        opts.appId,
        opts.deployId,
        req,
        opts.overlap?.scaled ? stackName(opts.slug) : undefined,
      );
    return r;
  };

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
      openDeployStream(first, req, opts.plan, hello.capabilities),
      opts.sink,
      cursor,
      () => {
        started = true;
      },
    );
    if (outcome.terminal) return offerBundle(outcome.terminal);
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
      // An agent that never connects would hold the stream (and the app's deploy slot) for its 30-minute deadline.
      await conn.hello();
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
      if (outcome.terminal) return offerBundle(outcome.terminal);
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

// Only the App's production stack carries its tunnel's connector; a preview is never served through it.
async function appConnectorToken(
  appId: string,
  slug: string,
): Promise<string | null> {
  const [app] = await getDb()
    .select({ slug: appsTable.slug })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  return app?.slug === slug ? loadAppConnectorToken(appId) : null;
}

// An upload's build folder goes up in chunks when the agent can take them, else whole.
export function openDeployStream(
  conn: Pick<AgentConnection, "deploy" | "deployStream">,
  req: DeployRequest,
  plan: AgentBuildPlan,
  capabilities: readonly string[],
): AsyncGenerator<DeployEvent, void, unknown> {
  const buildDir =
    plan.kind === "dockerfile"
      ? plan.buildDir
      : plan.kind === "source-compose" && plan.source.kind === "upload"
        ? plan.source.buildDir
        : null;
  if (!buildDir) return conn.deploy(req);
  if (capabilities.includes("deploy.context_stream")) {
    return conn.deployStream(req, tarDirChunks(buildDir));
  }
  return (async function* () {
    yield* conn.deploy({ ...req, contextTar: await tarDir(buildDir) });
  })();
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
    if (terminal !== undefined) return { terminal };
  }
  return { terminal: null };
}

export class AgentUnavailableError extends Error {}

function handleEvent(
  ev: DeployEvent,
  sink: AgentDeploySink,
): AgentDeployResult | undefined {
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
    return {
      ready: ev.result.ready,
      commitSha: ev.result.commitSha || "",
      error: ev.result.error || undefined,
      observedPort: ev.result.observedPort || undefined,
      builtWith: ev.result.builtWith || undefined,
      sourceCompose: ev.result.sourceCompose,
      listeningPorts: ev.result.listeningPorts,
    };
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

// Each new behaviour is the agent's to honour: an older one gets the request it understands.
function applyAgentFeatures(
  req: DeployRequest,
  opts: { ready?: ReadyCheck; githubToken?: string },
  capabilities: readonly string[],
  sink: AgentDeploySink,
): void {
  if (opts.ready && capabilities.includes("deploy.ready-check")) {
    req.ready = opts.ready;
    req.readyTimeoutMs = Math.max(req.readyTimeoutMs, READY_CHECK_TIMEOUT_MS);
  }
  if (
    opts.githubToken &&
    req.buildKind === BuildKind.BUILD_KIND_RAILPACK &&
    capabilities.includes("build.github-token")
  )
    req.githubToken = opts.githubToken;
  if (req.git?.submodules && !capabilities.includes("git.submodules")) {
    req.git.submodules = false;
    sink.log(
      "warn",
      "This server's agent is too old to check out git submodules, so this build has none. " +
        "Update the agent (reissue the install command from the server's actions menu).",
    );
  }
  if (
    req.buildSpec?.autoMethod &&
    !capabilities.includes("build.auto-method")
  ) {
    req.buildSpec.autoMethod = false;
    sink.log(
      "warn",
      "This server's agent is too old to look for a Dockerfile or a Compose file, so this " +
        "build uses Railpack. Update the agent (reissue the install command from the server's actions menu).",
    );
  }
}

// Long enough for a JVM or a Rails boot; a crash ends the wait at once.
const READY_CHECK_TIMEOUT_MS = 180_000;
