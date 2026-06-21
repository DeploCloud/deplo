import "server-only";

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAgent, agentPreflight } from "../infra/agent-client";
import type {
  AgentStartDev,
  AgentTunnelStatus,
} from "../infra/agent-client";
import type { DeployEvent } from "../agent/gen/agent";
import { extractArchive } from "./upload";
import { installationCloneUrl } from "../github/app";
import { dataVolumeHostMountpoint } from "./builders";
import {
  renderDevCompose,
  devEntryScript,
  workspaceDir,
  tunnelLaunchScript,
  type VscodeTunnelInfo,
  parseTunnelLog,
} from "./dev";
import type { Project } from "../types";

/**
 * The agent-dev seam (PLAN Part D). Dev containers + the VS Code tunnel are
 * per-host singletons (ADR-0002); once a project can live on a remote server, its
 * dev container must run THERE. This is the dev-mode counterpart of agent-deploy.ts:
 * the control plane still does policy + the store + ALL rendering (the dev compose,
 * the entrypoint script, the tokenized clone URL, the upload archive — D2/D4); the
 * agent owns the host-coupled half (write files, drive Docker). Both localhost and
 * remote route through `connectAgent(serverId)` — one uniform path (Decision 4),
 * the local agent being the first instance of it.
 */

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";

/** The owning server id for a project (every project carries one). */
function serverIdOf(project: Project): string {
  return project.serverId;
}

/**
 * Build the self-contained StartDev payload the agent needs: the rendered dev
 * compose (D2), the entrypoint script, the tokenized clone URL for a git source
 * (the control plane mints the GitHub App token — the agent never holds the key,
 * D4), the upload archive bytes for an upload source, and the host-translated
 * workspace path for the agent's pre-chown.
 */
export async function buildStartDevPayload(
  project: Project,
): Promise<AgentStartDev> {
  const slug = project.slug;
  const [composeYaml, cloneSecretUrl, uploadTar, workspaceHostPath] =
    await Promise.all([
      renderDevCompose(project),
      resolveCloneSecretUrl(project),
      buildUploadTar(project),
      hostWorkspacePath(slug),
    ]);
  return {
    slug,
    projectId: project.id,
    composeYaml,
    entryScript: devEntryScript(),
    cloneSecretUrl,
    uploadTar,
    workspaceHostPath,
  };
}

/**
 * The tokenized clone URL for a git source (a GitHub App installation token baked
 * in for private repos), or "" for a non-git source. Mirrors lib/deploy/dev.ts
 * writeCloneSecret's URL minting — but the agent writes the 0600 file, so only the
 * URL string crosses the wire (over mTLS). A minting failure degrades to the plain
 * URL (a public clone still works; a private one becomes an empty git workspace).
 */
async function resolveCloneSecretUrl(project: Project): Promise<string> {
  if (
    (project.source === "github" || project.source === "git") &&
    project.repo
  ) {
    try {
      return await installationCloneUrl(
        project.repo.url,
        project.repo.installationId ?? null,
      );
    } catch {
      return project.repo.url;
    }
  }
  return "";
}

/**
 * For an `upload` source, tar the (securely-extracted, single-root-collapsed)
 * archive so the agent can seed its workspace host-side. The control plane already
 * owns the archive under /data/uploads and the secure extract (zip-slip + symlink
 * guards); it ships the resulting tree as a ustar archive the agent extracts with
 * the SAME anti-escape guard. Empty for any other source. The agent only seeds an
 * EMPTY workspace (clone-once), so re-sending the tar on every start is harmless.
 */
async function buildUploadTar(project: Project): Promise<Buffer> {
  if (project.source !== "upload" || !project.upload) return Buffer.alloc(0);
  const tmp = await mkdtemp(join(tmpdir(), `deplo-devseed-${project.slug}-`));
  try {
    const root = await extractArchive(project.upload, tmp, () => {});
    return await tarDir(root);
  } catch {
    return Buffer.alloc(0);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** The host-translated `-v` source for the agent's pre-chown helper container. */
async function hostWorkspacePath(slug: string): Promise<string> {
  const mountpoint = await dataVolumeHostMountpoint();
  const ws = workspaceDir(slug);
  return mountpoint && ws.startsWith(DATA_DIR)
    ? join(mountpoint, ws.slice(DATA_DIR.length))
    : ws;
}

/** A sink the StartDev stream writes its log/phase events into. */
export interface DevSink {
  log?: (level: string, text: string) => void;
}

/** Drain a StartDev/ResetDevWorkspace stream into the sink; throw on a non-ready
 *  terminal result so the data layer marks the dev status `error`. */
async function consumeDevStream(
  stream: AsyncGenerator<DeployEvent, void, unknown>,
  sink: DevSink,
): Promise<void> {
  let terminal: { ready: boolean; error: string } | null = null;
  for await (const ev of stream) {
    if (ev.log) sink.log?.(ev.log.level, ev.log.text);
    else if (ev.result) terminal = { ready: ev.result.ready, error: ev.result.error };
  }
  if (terminal && !terminal.ready) {
    throw new Error(terminal.error || "Dev container failed to start");
  }
}

/**
 * Start (or restart) a project's dev container through its owning agent. A
 * mandatory Hello pre-flight (P5) fails fast if the agent is unreachable rather
 * than hanging. Streams progress into `sink`.
 */
export async function agentStartDev(
  project: Project,
  sink: DevSink = {},
): Promise<void> {
  const serverId = serverIdOf(project);
  const hello = await agentPreflight(serverId);
  if (!hello.dockerAvailable) {
    throw new Error("the agent reports Docker is not available on the target server");
  }
  const payload = await buildStartDevPayload(project);
  const conn = await connectAgent(serverId);
  try {
    await consumeDevStream(conn.startDev(payload), sink);
  } finally {
    conn.close();
  }
}

/** DESTRUCTIVE reset: wipe + reseed the workspace through the owning agent. */
export async function agentResetDevWorkspace(
  project: Project,
  sink: DevSink = {},
): Promise<void> {
  const serverId = serverIdOf(project);
  const hello = await agentPreflight(serverId);
  if (!hello.dockerAvailable) {
    throw new Error("the agent reports Docker is not available on the target server");
  }
  const payload = await buildStartDevPayload(project);
  const conn = await connectAgent(serverId);
  try {
    await consumeDevStream(conn.resetDevWorkspace(payload), sink);
  } finally {
    conn.close();
  }
}

/** Stop a project's dev container (reversible) through its owning agent. */
export async function agentStopDev(project: Project): Promise<void> {
  const conn = await connectAgent(serverIdOf(project));
  try {
    await conn.stopDev(project.slug);
  } finally {
    conn.close();
  }
}

/** Fully tear a dev container down on project delete (wipes the workspace). */
export async function agentTeardownDev(project: Project): Promise<void> {
  const conn = await connectAgent(serverIdOf(project));
  try {
    await conn.teardownDev(project.slug);
  } finally {
    conn.close();
  }
}

// ---- VS Code tunnel ----------------------------------------------------------

/** Map the agent's raw tunnel status to the parsed VscodeTunnelInfo (the parse
 *  stays pure in the control plane). */
function toTunnelInfo(s: AgentTunnelStatus): VscodeTunnelInfo {
  return {
    running: s.running,
    log: s.log.slice(-2000),
    ...parseTunnelLog(s.log),
  };
}

/** Start the tunnel through the owning agent, then poll briefly for the device-
 *  login link (the control plane drives the poll; the agent has no UI deadline). */
export async function agentStartTunnel(
  project: Project,
): Promise<VscodeTunnelInfo> {
  const serverId = serverIdOf(project);
  const conn = await connectAgent(serverId);
  try {
    await conn.startTunnel(project.slug, tunnelLaunchScript(project.slug));
    // Poll up to ~24s for the device-code line OR a completed connection (the CLI
    // download can take a moment). Return as soon as there's something to show.
    for (let i = 0; i < 12; i++) {
      const info = toTunnelInfo(await conn.getTunnel(project.slug));
      if (info.loginUrl || info.connected) return info;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return toTunnelInfo(await conn.getTunnel(project.slug));
  } finally {
    conn.close();
  }
}

/** Read the current tunnel status through the owning agent. */
export async function agentGetTunnel(
  project: Project,
): Promise<VscodeTunnelInfo> {
  const conn = await connectAgent(serverIdOf(project));
  try {
    return toTunnelInfo(await conn.getTunnel(project.slug));
  } finally {
    conn.close();
  }
}

/** Stop the tunnel through the owning agent (the container keeps running). */
export async function agentStopTunnel(project: Project): Promise<void> {
  const conn = await connectAgent(serverIdOf(project));
  try {
    await conn.stopTunnel(project.slug);
  } finally {
    conn.close();
  }
}

/** Tar a directory into memory as a ustar archive (the agent extracts it with its
 *  anti-escape guard). Mirrors agent-deploy.ts tarDir. */
function tarDir(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["--format=ustar", "-cf", "-", "-C", dir, "."], {
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tar exited ${code} while archiving the dev workspace seed`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
