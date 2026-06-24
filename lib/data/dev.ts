import "server-only";

import { eq } from "drizzle-orm";

import { read } from "../store";
import { getDb } from "../db/client";
import { projectDev as projectDevTable } from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import {
  loadProjectGraph,
  loadDeployment,
} from "./project-graph-load";
import { devToRow } from "./project-graph-rows";
import {
  defaultDevConfig,
  devImage,
  devPreviewUrl,
  workspaceHasSource,
  type VscodeTunnelInfo,
} from "../deploy/dev";
import {
  agentStartDev,
  agentStopDev,
  agentResetDevWorkspace,
  agentStartTunnel,
  agentStopTunnel,
  agentGetTunnel,
} from "../deploy/agent-dev";
import { ensureGateway } from "../infra/ssh-gateway";
import { startDeployment } from "../deploy/build";
import { usesComposeStack } from "../utils";
import type {
  DevConfig,
  DevStatus,
  DeploySource,
  Project,
  Deployment,
} from "../types";

/** Sources that put an editable source tree on the server (CONTEXT.md). */
const SOURCE_BEARING: DeploySource[] = ["github", "git", "upload"];

/** Whether dev mode is eligible for a project (source-bearing only). */
export function isDevEligible(source: DeploySource): boolean {
  return SOURCE_BEARING.includes(source);
}

async function requireProject(id: string): Promise<Project> {
  const p = await loadProjectGraph(id);
  if (!p) throw new Error("Project not found");
  return p;
}

/** Like {@link requireProject} but also asserts the project is in `teamId`. */
async function requireTeamProject(id: string, teamId: string): Promise<Project> {
  const p = await loadProjectGraph(id);
  if (!p || p.teamId !== teamId) throw new Error("Project not found");
  return p;
}

/** A client-safe view of a project's dev config + the computed preview URL. */
export interface DevInfo {
  enabled: boolean;
  status: DevStatus;
  imageKind: "preset" | "custom";
  image: string;
  /** The OFFICIAL base image the container actually runs on. */
  resolvedImage: string;
  devCommand: string;
  port: number;
  previewEnabled: boolean;
  previewUrl: string;
  latestStartAt: string | null;
  eligible: boolean;
}

export async function getDevInfo(projectId: string): Promise<DevInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadProjectGraph(projectId);
  if (!p || p.teamId !== teamId) return null;
  // Row ABSENT = dev never enabled (the tri-state). Fall back to a derived
  // default config for display, but report enabled/status from the real row.
  const dev = p.dev ?? defaultDevConfig(p);
  return {
    enabled: p.dev?.enabled ?? false,
    status: p.dev?.status ?? "off",
    imageKind: dev.imageKind,
    image: dev.image,
    resolvedImage: devImage({ ...p, dev }),
    devCommand: dev.devCommand,
    port: dev.port,
    previewEnabled: dev.previewEnabled,
    previewUrl: devPreviewUrl(p.slug),
    latestStartAt: dev.latestStartAt,
    eligible: isDevEligible(p.source),
  };
}

/**
 * Set the push-only dev status (mirrors setProject in build.ts). No-op when the
 * project has no `project_dev` row yet (dev never enabled — matches the old
 * `!p.dev` guard); enableDev/startDevContainer create the row first.
 */
export async function setDevStatus(
  projectId: string,
  status: DevStatus,
): Promise<void> {
  await getDb()
    .update(projectDevTable)
    .set({
      status,
      ...(status === "starting" ? { latestStartAt: nowIso() } : {}),
    })
    .where(eq(projectDevTable.projectId, projectId));
}

/** Upsert the `project_dev` row for a project (the 1-to-1 child). */
async function writeDevRow(projectId: string, dev: DevConfig): Promise<void> {
  const row = devToRow(projectId, dev);
  await getDb()
    .insert(projectDevTable)
    .values(row)
    .onConflictDoUpdate({ target: projectDevTable.projectId, set: row });
}

/**
 * Enable dev mode for a source-bearing project. Seeds a default DevConfig
 * (preset derived from framework, dev command from the framework, port =
 * build.port, preview on) into the `project_dev` row, materializing it if dev was
 * never enabled. Refuses non-source-bearing projects. Does NOT start the
 * container — that is startDevContainer().
 */
export async function enableDev(projectId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamProject(projectId, membership.teamId);
  if (!isDevEligible(p.source)) {
    throw new Error("Dev mode is only available for git or upload projects");
  }
  const next: DevConfig = p.dev
    ? { ...p.dev, enabled: true }
    : { ...defaultDevConfig(p), enabled: true };
  await writeDevRow(projectId, next);
  recordActivity("project", "Enabled dev mode", user.name, projectId);
}

/** Patch a project's dev config (image/command/port/preview). */
export async function updateDev(
  projectId: string,
  patch: Partial<
    Pick<
      DevConfig,
      "imageKind" | "image" | "devCommand" | "port" | "previewEnabled"
    >
  >,
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const proj = await requireTeamProject(projectId, membership.teamId);
  // Enforce eligibility at the data layer, not just the UI — updateDevAction is
  // a directly-callable server action.
  if (!isDevEligible(proj.source)) {
    throw new Error("Dev mode is only available for git or upload projects");
  }
  const base = proj.dev ?? defaultDevConfig(proj);
  await writeDevRow(projectId, { ...base, ...patch });
  recordActivity("project", "Updated dev settings", user.name, projectId);
}

/**
 * Disable dev mode: stop the container but KEEP the workspace (disable is
 * reversible — re-enabling resumes the edited tree). The gateway and the
 * project's SSH users are untouched.
 */
export async function disableDev(projectId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamProject(projectId, membership.teamId);
  await agentStopDev(p).catch(() => {});
  // Only when a row exists (dev was enabled at some point) — keep the tri-state.
  if (p.dev) {
    await getDb()
      .update(projectDevTable)
      .set({ enabled: false, status: "off" })
      .where(eq(projectDevTable.projectId, projectId));
  }
  recordActivity("project", "Disabled dev mode", user.name, projectId);
}

/** Start (or restart) the dev container. Sets status push-only. */
export async function startDevContainer(projectId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamProject(projectId, membership.teamId);
  if (!isDevEligible(p.source)) {
    throw new Error("Dev mode is only available for git or upload projects");
  }
  if (!p.dev?.enabled) await enableDev(projectId);
  await setDevStatus(projectId, "starting");
  try {
    const fresh = await requireProject(projectId);
    await agentStartDev(fresh);
    await setDevStatus(projectId, "running");
  } catch (e) {
    await setDevStatus(projectId, "error");
    throw e;
  }
  // If this project has SSH users, (re)establish the gateway on its server so a
  // restarted/drifted gateway reconciles them (ADR-0002: lazy, never at install —
  // so only when users actually exist, never opening port 2222 otherwise). The
  // gateway is a separate singleton that survives dev-container restarts; this is
  // best-effort drift repair, not a hard dependency of the start.
  if (read().devSshUsers.some((u) => u.projectId === projectId)) {
    await ensureGateway(p.serverId).catch(() => {});
  }
  recordActivity("project", "Started dev container", user.name, projectId);
}

/** Stop the dev container (reversible; workspace kept). */
export async function stopDevContainer(projectId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamProject(projectId, membership.teamId);
  await agentStopDev(p);
  await setDevStatus(projectId, "stopped");
  recordActivity("project", "Stopped dev container", user.name, projectId);
}

/**
 * DESTRUCTIVE: replace the workspace with a fresh copy of the CURRENT deploy
 * source (used after changing the source, or to discard the working tree).
 * Wipes all files — including uncommitted edits — then reseeds and restarts.
 */
export async function resetDevWorkspace(projectId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamProject(projectId, membership.teamId);
  if (!isDevEligible(p.source)) {
    throw new Error("Dev mode is only available for git or upload projects");
  }
  if (!p.dev?.enabled) {
    throw new Error("Enable dev mode before resetting the workspace");
  }
  await setDevStatus(projectId, "starting");
  try {
    await agentResetDevWorkspace(p);
    await setDevStatus(projectId, "running");
  } catch (e) {
    await setDevStatus(projectId, "error");
    throw e;
  }
  recordActivity(
    "project",
    "Reset dev workspace from source",
    user.name,
    projectId,
  );
}

/**
 * Deploy the CURRENT files in the dev workspace to PRODUCTION — the developer's
 * live, edited tree at /data/dev/<slug> — WITHOUT committing, pushing, or
 * re-cloning the source. CONTEXT.md's explicit exception to "deploy never
 * touches the dev workspace": here we deploy FROM it.
 *
 * The dev container need NOT be running — the build reads the files on disk, not
 * the live process. The real gate is that the workspace HAS source (start dev
 * mode at least once). Recorded as a normal production, image-based Deployment
 * labelled "Deploy from dev workspace" so it's distinguishable in history.
 */
export async function deployDevWorkspace(
  projectId: string,
): Promise<Deployment> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamProject(projectId, membership.teamId);
  if (!isDevEligible(p.source)) {
    throw new Error("Dev mode is only available for git or upload projects");
  }
  // A dev-eligible source is never a compose/docker-image stack, so a workspace
  // deploy is always a single-image build. Guard anyway so a future source
  // change can't silently route a stack through the image path.
  if (usesComposeStack(p)) {
    throw new Error("Cannot deploy a compose stack from the dev workspace");
  }
  // The real precondition: files on disk. Not "enabled", not "running" — a
  // workspace seeded once and then stopped still has the edited tree to deploy.
  // For a LOCALHOST project the workspace is on this disk, so we pre-check it for
  // a friendly error. For a REMOTE project the workspace lives on the agent, so
  // the check runs THERE (the agent's DEV_WORKSPACE build errors clearly on an
  // empty/missing workspace) — a local check would read the wrong host's disk.
  const server = read().servers.find((s) => s.id === p.serverId);
  if (server?.type !== "remote" && !(await workspaceHasSource(p.slug))) {
    throw new Error(
      "No files to deploy yet. Start dev mode at least once so the workspace has source.",
    );
  }

  const depId = await startDeployment(projectId, {
    environment: "production",
    creator: user.name,
    commitMessage: "Deploy from dev workspace",
    buildSource: "dev-workspace",
  });

  // Present tense: the deploy is queued/fire-and-forget — it may still fail
  // during the build, so don't claim past-tense success here. (startDeployment
  // also logs its own "Deploying <name>" row; this adds the provenance.)
  recordActivity(
    "deployment",
    "Deploying from dev workspace",
    user.name,
    projectId,
  );

  const dep = await loadDeployment(depId);
  if (!dep) throw new Error("Deployment was not created");
  return dep;
}

// ---- VS Code Remote Tunnel (the editor integration; see deploy/dev.ts) -------

export type { VscodeTunnelInfo } from "../deploy/dev";

/**
 * Start the VS Code tunnel inside the project's dev container and return the
 * device-login link the user must authorize. Requires a running dev container.
 */
export async function startTunnel(projectId: string): Promise<VscodeTunnelInfo> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamProject(projectId, membership.teamId);
  if (!isDevEligible(p.source)) {
    throw new Error("Dev mode is only available for git or upload projects");
  }
  if (p.dev?.status !== "running") {
    throw new Error("Start the dev container before opening it in VS Code");
  }
  const info = await agentStartTunnel(p);
  recordActivity("project", "Opened dev container in VS Code", user.name, projectId);
  return info;
}

/** Current tunnel status (device link / connected URL / running). */
export async function getTunnel(projectId: string): Promise<VscodeTunnelInfo> {
  const teamId = await requireActiveTeamId();
  const p = await requireTeamProject(projectId, teamId);
  return agentGetTunnel(p);
}

/** Stop the VS Code tunnel (the dev container keeps running). */
export async function stopTunnel(projectId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamProject(projectId, membership.teamId);
  await agentStopTunnel(p);
  recordActivity("project", "Closed VS Code tunnel", user.name, projectId);
}
