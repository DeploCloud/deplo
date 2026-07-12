import { newId } from "../ids";
import { normalizeBuildConfig } from "../frameworks";
import type { Service, VolumeMount } from "../types";

/**
 * Pure, store-free read-time normalizers for a project (relational-store PLAN §7
 * "normalize BEFORE exploding into strict child tables").
 *
 * Extracted from `lib/data/services.ts` so BOTH the live read path AND the
 * service-graph backfill apply the IDENTICAL normalization before a legacy row is
 * exploded into the strict NOT-NULL child tables — the same anti-drift split as
 * `service-graph-rows.ts`. These touch no store/db and import only pure helpers
 * (`newId`, `normalizeBuildConfig`), so the backfill can import them without
 * pulling in the `server-only` data layer. `services.ts` re-exports them so its
 * existing internal call sites are unchanged.
 */

/** A docker-volume-safe name derived from a mount path when the user left the
 *  name blank (e.g. "/var/data" → "var-data", "/" → "data"). */
export function deriveVolumeName(mountPath: string): string {
  const s = mountPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "data";
}

/**
 * Backfill/sanitize a project's named volumes on read. Absent ⇒ null (so
 * renderCompose emits nothing and the stack stays byte-identical). Returns the
 * SAME reference when nothing changes so `normalizeService`'s early-return still
 * fires for the common (modern) row. Entries with no mountPath are dropped;
 * missing id/name are backfilled.
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
 * Backfill a project read from the store to the current model. The legacy
 * "dockerfile" deploy source was folded into the "dockerfile" build method
 * (build from the repo's Dockerfile is *how* you build, not *where* code comes
 * from), so old services on that source are remapped to a plain git/github
 * source with their build method forced to "dockerfile". Pure and idempotent.
 */
export function normalizeService<T extends Service>(p: T): T {
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
