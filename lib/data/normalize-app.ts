// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { newId } from "../ids";
import { normalizeBuildConfig } from "../frameworks";
import { deriveVolumeName } from "../apps/volume-model";
import type { App, VolumeMount } from "../types";

/**
 * Pure, store-free read-time normalizers for a project (relational-store PLAN §7
 * "normalize BEFORE exploding into strict child tables").
 */

/**
 * A docker-volume-safe name derived from a mount path when the user left the name
 * blank (e.g. "/var/data" → "var-data", "/" → "data").
 */
export { deriveVolumeName } from "../apps/volume-model";

/**
 * Backfill/sanitize a project's named volumes on read.
 */
export function normalizeVolumes(
  raw: VolumeMount[] | null | undefined,
): VolumeMount[] | null {
  if (!raw || raw.length === 0) return raw == null ? null : raw;
  let changed = false;
  const out: VolumeMount[] = [];
  for (const v of raw) {
    const mountPath = (v?.mountPath ?? "").trim();
    if (!mountPath) {
      changed = true;
      continue;
    }
    const isHost = v?.type === "host";
    const name = (v?.name ?? "").trim() || deriveVolumeName(mountPath);
    const id = v?.id || newId("vol");
    const readOnly = Boolean(v?.readOnly);
    const hostPath = (v?.hostPath ?? "").trim();
    if (
      v.id !== id ||
      v.mountPath !== mountPath ||
      v.name !== name ||
      v.readOnly !== readOnly ||
      (isHost && v.hostPath !== hostPath)
    ) {
      changed = true;
    }
    out.push(
      isHost
        ? { id, type: "host", name, hostPath, mountPath, readOnly }
        : { id, name, mountPath, readOnly },
    );
  }
  return changed ? (out.length ? out : null) : raw;
}

/**
 * Backfill a project read from the store to the current model.
 */
export function normalizeApp<T extends App>(p: T): T {
  const build = normalizeBuildConfig(p.build);
  const volumes = normalizeVolumes(p.volumes);
  const legacySource = (p.source as string) === "dockerfile";
  if (!legacySource && build === p.build && volumes === p.volumes) return p;
  return {
    ...p,
    source: legacySource
      ? p.repo?.provider === "github"
        ? "github"
        : "git"
      : p.source,
    build: legacySource ? { ...build, buildMethod: "dockerfile" } : build,
    volumes,
  };
}
