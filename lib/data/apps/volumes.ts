import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  apps as appsTable,
  appVolumes as appVolumesTable,
} from "../../db/schema/control-plane/apps";
import { getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import { requireMountHostVolumes } from "../../membership";
import { composeServiceNames } from "../../deploy/compose-stack/compose-read";
import {
  deriveVolumeName,
  kindOf,
  reservedMountPath,
  VOLUME_NAME_MAX,
  VOLUME_NAME_RE,
} from "../../apps/volume-model";
import { MOUNT_PROPAGATIONS } from "../../types/container";
import { loadAppGraph } from "../app-graph-load";
import { volumesToRows } from "../app-graph-rows/app";
import { requireAppCapability } from "../node-access";
import { recordActivity } from "../activity";
import { usesComposeStack } from "../../utils";
import type { VolumeMount } from "../../types/container";

export { deriveVolumeName };

export function validateVolumes(
  raw: VolumeMount[],
  existingMounts: { filePath: string }[] | null | undefined,
  composeServices?: string[] | null,
  opts?: {
    imported?: boolean;
  },
): VolumeMount[] | null {
  const seenPath = new Set<string>();
  const seenName = new Set<string>();
  const mountFilePaths = (existingMounts ?? []).map((m) => m.filePath);
  const out: VolumeMount[] = [];
  for (const v of raw) {
    let service: string | null = null;
    if (composeServices) {
      const wanted = (v.service ?? "").trim();
      if (wanted && !composeServices.includes(wanted)) {
        throw new Error(
          `Compose service "${wanted}" is not in this app's compose file.`,
        );
      }
      service = wanted || null;
    }
    const mountPath = (v.mountPath ?? "").trim().replace(/\/+$/, "") || "/";

    if (!/^\/[^\s:$]*$/.test(mountPath) || mountPath.length < 2) {
      throw new Error(
        `Mount path must be an absolute path with no spaces, ":" or "$": "${v.mountPath}"`,
      );
    }
    if (mountPath.split("/").includes("..")) {
      throw new Error(`Mount path must not contain "..": "${v.mountPath}"`);
    }

    if (reservedMountPath(mountPath, opts?.imported ? "app" : kindOf(v))) {
      throw new Error(`Mount path "${mountPath}" is reserved by the system.`);
    }
    if (
      mountFilePaths.some((raw) => {
        const f = raw.replace(/\/+$/, "");
        return (
          f === mountPath ||
          mountPath.startsWith(f + "/") ||
          f.startsWith(mountPath + "/")
        );
      })
    ) {
      throw new Error(
        `Mount path "${mountPath}" conflicts with a template config file.`,
      );
    }
    const pathKey = `${service ?? ""}\u0000${mountPath}`;
    if (seenPath.has(pathKey)) {
      throw new Error(`Duplicate mount path: "${mountPath}"`);
    }
    seenPath.add(pathKey);

    const name = (
      (v.name ?? "").trim() || deriveVolumeName(mountPath)
    ).toLowerCase();

    if (v.type === "app") {
      const projectPath = (v.projectPath ?? "")
        .trim()
        .replace(/^\.\/+/, "")
        .replace(/\/+$/, "");
      if (projectPath === "" || projectPath.startsWith("/")) {
        throw new Error(
          `The path in this app's Files must be relative, for example "config.toml": "${v.projectPath}"`,
        );
      }
      if (/[\s:$]/.test(projectPath)) {
        throw new Error(
          `The path in this app's Files cannot contain spaces, ":" or "$": "${v.projectPath}"`,
        );
      }
      if (projectPath.split("/").includes("..")) {
        throw new Error(
          `The path in this app's Files cannot contain "..": "${v.projectPath}"`,
        );
      }
      out.push({
        id: v.id || newId("vol"),
        type: "app",
        name,
        projectPath,
        ...(service ? { service } : {}),
        mountPath,
        readOnly: Boolean(v.readOnly),
      });
      continue;
    }

    if (v.type === "host") {
      const hostPath = (v.hostPath ?? "").trim().replace(/\/+$/, "");
      if (!/^\/[^\s:$]*$/.test(hostPath) || hostPath.length < 2) {
        throw new Error(
          `The path on the server must be absolute, with no spaces, ":" or "$": "${v.hostPath}"`,
        );
      }
      if (hostPath.split("/").includes("..")) {
        throw new Error(
          `The path on the server cannot contain "..": "${v.hostPath}"`,
        );
      }

      const propagation = v.propagation;
      if (propagation && !MOUNT_PROPAGATIONS.includes(propagation)) {
        throw new Error(
          `Unknown mount propagation "${propagation}" - use ${MOUNT_PROPAGATIONS.join(" or ")}.`,
        );
      }
      out.push({
        id: v.id || newId("vol"),
        type: "host",
        name,
        hostPath,
        ...(service ? { service } : {}),
        mountPath,
        readOnly: Boolean(v.readOnly),
        ...(propagation ? { propagation } : {}),
      });
      continue;
    }

    if (!VOLUME_NAME_RE.test(name) || name.length > VOLUME_NAME_MAX) {
      throw new Error(
        `Volume name "${name}" must be lowercase letters, digits, "-"/"_" (max ${VOLUME_NAME_MAX}).`,
      );
    }
    if (seenName.has(name)) {
      throw new Error(`Duplicate volume name: "${name}"`);
    }
    seenName.add(name);

    out.push({
      id: v.id || newId("vol"),
      name,
      ...(service ? { service } : {}),
      mountPath,
      readOnly: Boolean(v.readOnly),
    });
  }
  return out.length ? out : null;
}

export async function setAppVolumes(
  id: string,
  volumes: VolumeMount[],
  opts?: {
    imported?: boolean;
  },
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");

  if (volumes.some((v) => v.type === "host")) {
    await requireMountHostVolumes();
  }
  const user = (await getCurrentUser())!;
  await getDb().transaction(async (tx) => {
    const p = await loadAppGraph(id, tx);
    if (!p || p.teamId !== membership.teamId) throw new Error("App not found");
    const composeServices = usesComposeStack(p)
      ? composeServiceNames(p.compose)
      : null;
    const validated = validateVolumes(volumes, p.mounts, composeServices, opts);
    await tx.delete(appVolumesTable).where(eq(appVolumesTable.appId, id));
    const rows = volumesToRows(id, validated);
    if (rows.length > 0) await tx.insert(appVolumesTable).values(rows);
    await tx
      .update(appsTable)
      .set({ updatedAt: nowIso() })
      .where(eq(appsTable.id, id));
  });
  await recordActivity("app", `Updated volumes`, user.name, id);
}
