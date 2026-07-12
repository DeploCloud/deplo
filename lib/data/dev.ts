import "server-only";

import { eq } from "drizzle-orm";

import { getServerById } from "./servers";
import { appHasDevSshUsers } from "./dev-ssh";
import { requireFolderCapabilityForApp } from "./folder-access";
import { getDb } from "../db/client";
import { appDev as appDevTable } from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import {
  loadAppGraph,
  loadDeployment,
} from "./app-graph-load";
import { devToRow } from "./app-graph-rows";
import {
  defaultDevConfig,
  devImage,
  devPreviewUrl,
  newDevPreviewHost,
  workspaceHasSource,
  type VscodeTunnelInfo,
} from "../deploy/dev";
import { resolveServerIp } from "../deploy/domains";
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
  App,
  Deployment,
} from "../types";

/** Sources that put an editable source tree on the server (CONTEXT.md). */
const SOURCE_BEARING: DeploySource[] = ["github", "git", "upload"];

/** Whether dev mode is eligible for a project (source-bearing only). */
export function isDevEligible(source: DeploySource): boolean {
  return SOURCE_BEARING.includes(source);
}

async function requireApp(id: string): Promise<App> {
  const p = await loadAppGraph(id);
  if (!p) throw new Error("App not found");
  return p;
}

/** Like {@link requireApp} but also asserts the project is in `teamId`. */
async function requireTeamApp(id: string, teamId: string): Promise<App> {
  const p = await loadAppGraph(id);
  if (!p || p.teamId !== teamId) throw new Error("App not found");
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

export async function getDevInfo(appId: string): Promise<DevInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadAppGraph(appId);
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
    previewUrl: devPreviewUrl({ slug: p.slug, dev: p.dev }),
    latestStartAt: dev.latestStartAt,
    eligible: isDevEligible(p.source),
  };
}

/**
 * Set the push-only dev status (mirrors setApp in build.ts). No-op when the
 * project has no `app_dev` row yet (dev never enabled — matches the old
 * `!p.dev` guard); enableDev/startDevContainer create the row first.
 */
export async function setDevStatus(
  appId: string,
  status: DevStatus,
): Promise<void> {
  await getDb()
    .update(appDevTable)
    .set({
      status,
      ...(status === "starting" ? { latestStartAt: nowIso() } : {}),
    })
    .where(eq(appDevTable.appId, appId));
}

/** Upsert the `app_dev` row for a project (the 1-to-1 child). */
async function writeDevRow(appId: string, dev: DevConfig): Promise<void> {
  const row = devToRow(appId, dev);
  await getDb()
    .insert(appDevTable)
    .values(row)
    .onConflictDoUpdate({ target: appDevTable.appId, set: row });
}

/**
 * Enable dev mode for a source-bearing project. Seeds a default DevConfig
 * (node base image, no dev command, port = build.port, preview on) into the
 * `app_dev` row, materializing it if dev was
 * never enabled. Refuses non-source-bearing apps. Does NOT start the
 * container — that is startDevContainer().
 */
export async function enableDev(appId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamApp(appId, membership.teamId);
  await requireFolderCapabilityForApp(appId, "deploy");
  if (!isDevEligible(p.source)) {
    throw new Error("Dev mode is only available for git or upload apps");
  }
  const base: DevConfig = p.dev
    ? { ...p.dev, enabled: true }
    : { ...defaultDevConfig(p), enabled: true };
  // Bake the random-word preview host ONCE, the first time dev is enabled (or to
  // heal a legacy row that predates this field). The stored value is the source
  // of truth for the env var, the Traefik label, and the displayed URL — never
  // recomputed. Generated against the project's server IP.
  const next: DevConfig = base.previewHost
    ? base
    : {
        ...base,
        previewHost: newDevPreviewHost(
          p.slug,
          resolveServerIp(await getServerById(p.serverId) ?? undefined),
        ),
      };
  await writeDevRow(appId, next);
  await recordActivity("app", "Enabled dev mode", user.name, appId);
}

/** Patch a project's dev config (image/command/port/preview). */
export async function updateDev(
  appId: string,
  patch: Partial<
    Pick<
      DevConfig,
      "imageKind" | "image" | "devCommand" | "port" | "previewEnabled"
    >
  >,
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const proj = await requireTeamApp(appId, membership.teamId);
  await requireFolderCapabilityForApp(appId, "deploy");
  // Enforce eligibility at the data layer, not just the UI — updateDevAction is
  // a directly-callable server action.
  if (!isDevEligible(proj.source)) {
    throw new Error("Dev mode is only available for git or upload apps");
  }
  const base = proj.dev ?? defaultDevConfig(proj);
  await writeDevRow(appId, { ...base, ...patch });
  await recordActivity("app", "Updated dev settings", user.name, appId);
}

/**
 * Disable dev mode: stop the container but KEEP the workspace (disable is
 * reversible — re-enabling resumes the edited tree). The gateway and the
 * project's SSH users are untouched.
 */
export async function disableDev(appId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamApp(appId, membership.teamId);
  await requireFolderCapabilityForApp(appId, "deploy");
  await agentStopDev(p).catch(() => {});
  // Only when a row exists (dev was enabled at some point) — keep the tri-state.
  if (p.dev) {
    await getDb()
      .update(appDevTable)
      .set({ enabled: false, status: "off" })
      .where(eq(appDevTable.appId, appId));
  }
  await recordActivity("app", "Disabled dev mode", user.name, appId);
}

/** Start (or restart) the dev container. Sets status push-only. */
export async function startDevContainer(appId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamApp(appId, membership.teamId);
  await requireFolderCapabilityForApp(appId, "deploy");
  if (!isDevEligible(p.source)) {
    throw new Error("Dev mode is only available for git or upload apps");
  }
  if (!p.dev?.enabled) await enableDev(appId);
  // Heal a legacy enabled row that predates the stored preview host: bake one
  // now so the render (env var + Traefik label) uses a single persisted value
  // instead of re-deriving a different random host on every restart. (A freshly
  // enabled row already got one in enableDev above.)
  else if (p.dev && !p.dev.previewHost) {
    await writeDevRow(appId, {
      ...p.dev,
      previewHost: newDevPreviewHost(
        p.slug,
        resolveServerIp((await getServerById(p.serverId)) ?? undefined),
      ),
    });
  }
  await setDevStatus(appId, "starting");
  try {
    const fresh = await requireApp(appId);
    await agentStartDev(fresh);
    await setDevStatus(appId, "running");
  } catch (e) {
    await setDevStatus(appId, "error");
    throw e;
  }
  // If this project has SSH users, (re)establish the gateway on its server so a
  // restarted/drifted gateway reconciles them (ADR-0002: lazy, never at install —
  // so only when users actually exist, never opening port 2222 otherwise). The
  // gateway is a separate singleton that survives dev-container restarts; this is
  // best-effort drift repair, not a hard dependency of the start.
  if (await appHasDevSshUsers(appId)) {
    await ensureGateway(p.serverId).catch(() => {});
  }
  await recordActivity("app", "Started dev container", user.name, appId);
}

/** Stop the dev container (reversible; workspace kept). */
export async function stopDevContainer(appId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamApp(appId, membership.teamId);
  await requireFolderCapabilityForApp(appId, "deploy");
  await agentStopDev(p);
  await setDevStatus(appId, "stopped");
  await recordActivity("app", "Stopped dev container", user.name, appId);
}

/**
 * DESTRUCTIVE: replace the workspace with a fresh copy of the CURRENT deploy
 * source (used after changing the source, or to discard the working tree).
 * Wipes all files — including uncommitted edits — then reseeds and restarts.
 */
export async function resetDevWorkspace(appId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamApp(appId, membership.teamId);
  await requireFolderCapabilityForApp(appId, "deploy");
  if (!isDevEligible(p.source)) {
    throw new Error("Dev mode is only available for git or upload apps");
  }
  if (!p.dev?.enabled) {
    throw new Error("Enable dev mode before resetting the workspace");
  }
  await setDevStatus(appId, "starting");
  try {
    await agentResetDevWorkspace(p);
    await setDevStatus(appId, "running");
  } catch (e) {
    await setDevStatus(appId, "error");
    throw e;
  }
  await recordActivity(
    "app",
    "Reset dev workspace from source",
    user.name,
    appId,
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
  appId: string,
): Promise<Deployment> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamApp(appId, membership.teamId);
  await requireFolderCapabilityForApp(appId, "deploy");
  if (!isDevEligible(p.source)) {
    throw new Error("Dev mode is only available for git or upload apps");
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
  const server = await getServerById(p.serverId);
  if (server?.type !== "remote" && !(await workspaceHasSource(p.slug))) {
    throw new Error(
      "No files to deploy yet. Start dev mode at least once so the workspace has source.",
    );
  }

  const depId = await startDeployment(appId, {
    environment: "production",
    creator: user.name,
    commitMessage: "Deploy from dev workspace",
    buildSource: "dev-workspace",
  });

  // Present tense: the deploy is queued/fire-and-forget — it may still fail
  // during the build, so don't claim past-tense success here. (startDeployment
  // also logs its own "Deploying <name>" row; this adds the provenance.)
  await recordActivity(
    "deployment",
    "Deploying from dev workspace",
    user.name,
    appId,
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
export async function startTunnel(appId: string): Promise<VscodeTunnelInfo> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamApp(appId, membership.teamId);
  await requireFolderCapabilityForApp(appId, "deploy");
  if (!isDevEligible(p.source)) {
    throw new Error("Dev mode is only available for git or upload apps");
  }
  if (p.dev?.status !== "running") {
    throw new Error("Start the dev container before opening it in VS Code");
  }
  const info = await agentStartTunnel(p);
  await recordActivity("app", "Opened dev container in VS Code", user.name, appId);
  return info;
}

/** Current tunnel status (device link / connected URL / running). */
export async function getTunnel(appId: string): Promise<VscodeTunnelInfo> {
  const teamId = await requireActiveTeamId();
  const p = await requireTeamApp(appId, teamId);
  return agentGetTunnel(p);
}

/** Stop the VS Code tunnel (the dev container keeps running). */
export async function stopTunnel(appId: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const p = await requireTeamApp(appId, membership.teamId);
  await requireFolderCapabilityForApp(appId, "deploy");
  await agentStopTunnel(p);
  await recordActivity("app", "Closed VS Code tunnel", user.name, appId);
}
