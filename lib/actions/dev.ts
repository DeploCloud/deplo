"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  enableDev,
  disableDev,
  updateDev,
  startDevContainer,
  stopDevContainer,
  resetDevWorkspace,
  deployDevWorkspace,
  startTunnel,
  getTunnel,
  stopTunnel,
  type VscodeTunnelInfo,
} from "@/lib/data/dev";
import {
  createDevSshUser,
  removeDevSshUser,
} from "@/lib/data/dev-ssh";
import type { DevSshUserDTO } from "@/lib/types";

function revalidateDevViews(): void {
  revalidatePath("/");
  revalidatePath("/(dashboard)/projects/[slug]/settings", "page");
}

export async function enableDevAction(projectId: string): Promise<ActionResult> {
  const res = await run(() => enableDev(projectId));
  if (res.ok) revalidateDevViews();
  return res as ActionResult;
}

export async function disableDevAction(
  projectId: string,
): Promise<ActionResult> {
  const res = await run(() => disableDev(projectId));
  if (res.ok) revalidateDevViews();
  return res as ActionResult;
}

const updateDevSchema = z.object({
  imageKind: z.enum(["preset", "custom"]).optional(),
  image: z.string().max(200).optional(),
  devCommand: z.string().max(500).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  previewEnabled: z.boolean().optional(),
});

export async function updateDevAction(
  projectId: string,
  patch: z.input<typeof updateDevSchema>,
): Promise<ActionResult> {
  const parsed = updateDevSchema.safeParse(patch);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() => updateDev(projectId, parsed.data));
  if (res.ok) revalidateDevViews();
  return res as ActionResult;
}

export async function startDevAction(
  projectId: string,
): Promise<ActionResult> {
  const res = await run(() => startDevContainer(projectId));
  if (res.ok) revalidateDevViews();
  return res as ActionResult;
}

export async function stopDevAction(projectId: string): Promise<ActionResult> {
  const res = await run(() => stopDevContainer(projectId));
  if (res.ok) revalidateDevViews();
  return res as ActionResult;
}

export async function resetDevWorkspaceAction(
  projectId: string,
): Promise<ActionResult> {
  const res = await run(() => resetDevWorkspace(projectId));
  if (res.ok) revalidateDevViews();
  return res as ActionResult;
}

export async function deployDevWorkspaceAction(
  projectId: string,
): Promise<ActionResult<{ deploymentId: string }>> {
  const res = await run(async () => {
    const dep = await deployDevWorkspace(projectId);
    return { deploymentId: dep.id };
  });
  if (res.ok) {
    revalidateDevViews();
    // Surface the new deployment in the deployments views too (matches
    // redeployAction's revalidation) — the global list and the project's tab.
    revalidatePath("/deployments");
    revalidatePath("/(dashboard)/projects/[slug]/deployments", "page");
  }
  return res;
}

// No control chars / newlines: a newline in the password injects a second
// chpasswd mapping; a newline in the key injects an extra authorized_keys line.
const NO_CONTROL = /^[^\x00-\x1f\x7f]*$/;

const addSshUserSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1).max(24),
    publicKey: z
      .string()
      .max(8000)
      .regex(/^[^\n\r]*$/, "SSH key must be a single line")
      .optional()
      .nullable(),
    password: z
      .string()
      .max(200)
      .regex(NO_CONTROL, "Password must not contain control characters")
      .optional()
      .nullable(),
  })
  // At least one credential — the "neither" state is rejected (key is default).
  .refine((v) => Boolean(v.publicKey?.trim()) || Boolean(v.password?.trim()), {
    message: "Provide an SSH key or a password (at least one)",
    path: ["publicKey"],
  });

export async function addDevSshUserAction(
  input: z.input<typeof addSshUserSchema>,
): Promise<ActionResult<DevSshUserDTO>> {
  const parsed = addSshUserSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  const res = await run(() => createDevSshUser(parsed.data));
  if (res.ok) revalidateDevViews();
  return res;
}

export async function removeDevSshUserAction(
  id: string,
): Promise<ActionResult> {
  const res = await run(() => removeDevSshUser(id));
  if (res.ok) revalidateDevViews();
  return res as ActionResult;
}

// ---- VS Code Remote Tunnel ---------------------------------------------------

export async function startTunnelAction(
  projectId: string,
): Promise<ActionResult<VscodeTunnelInfo>> {
  return run(() => startTunnel(projectId));
}

export async function getTunnelAction(
  projectId: string,
): Promise<ActionResult<VscodeTunnelInfo>> {
  return run(() => getTunnel(projectId));
}

export async function stopTunnelAction(
  projectId: string,
): Promise<ActionResult> {
  const res = await run(() => stopTunnel(projectId));
  return res as ActionResult;
}
