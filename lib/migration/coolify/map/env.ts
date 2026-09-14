import { parseEnvBlob, sharedRefsIn } from "../../map/env";
import type { SharedRef } from "../../map/env";
import type { CoolifyEnv } from "../client";

// CoolifyEnvRead - one resource's variables, read out of Coolify's rows.
export interface CoolifyEnvRead {
  /** `KEY=value` lines, in the shape `parseEnvBlob` reads. */
  blob: string;
  /** Keys carried only for a preview deployment. */
  previewKeys: string[];
  /** Those same keys with their values, for Deplo's own preview variables. */
  previewBlob: string;
  /** Keys that were build-time only over there. */
  buildOnlyKeys: string[];
  /** Shared variables this resource referenced, read off the STORED value. */
  sharedRefs: SharedRef[];
  /** True when no row carried a `value` at all: a token without `read:sensitive`. */
  masked: boolean;
  /** Keys the panel would not answer a value for - they arrive EMPTY, which is not
   *  a fact about the value. */
  unreadableKeys: string[];
  /** Keys holding a `$` Coolify did NOT mark literal: compose interpolated them at
   *  deploy, so the container there saw something else than the text. */
  interpolatedKeys: string[];
  /** Keys the panel marked "shown once" AND answered a value for: its secrets. */
  secretKeys: string[];
}

/** A value that spans lines, wrapped so the shared line parser reads it whole.
 *  Left alone when the panel already wrapped it, or when it holds both quotes. */
function serializeValue(value: string): string {
  if (!value.includes("\n")) return value;
  for (const q of ["'", '"'])
    if (value.startsWith(q) && value.endsWith(q)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return value;
}

/**
 * Coolify's own bookkeeping, injected into every resource it runs. It names the
 * machine and the panel this is LEAVING, so as a team shared variable it is a row
 * nobody can act on that outlives the revert.
 */
export function withoutPanelInternals(blob: string): string {
  const entries = parseEnvBlob(blob);
  const kept = entries.filter(({ key }) => !/^COOLIFY_/i.test(key.trim()));
  // Untouched when there is nothing to drop, so the text somebody wrote is never
  // re-serialised for no reason.
  if (kept.length === entries.length) return blob;
  return kept
    .map(({ key, value }) => `${key}=${serializeValue(value)}`)
    .join("\n");
}

export function coolifyEnvBlob(rows: CoolifyEnv[]): CoolifyEnvRead {
  const lines: string[] = [];
  const previewKeys: string[] = [];
  const previewLines = new Map<string, string>();
  const buildOnlyKeys: string[] = [];
  const unreadableKeys: string[] = [];
  const interpolatedKeys: string[] = [];
  const secretKeys: string[] = [];
  const sharedRefs: SharedRef[] = [];
  let sawValue = false;

  for (const r of rows) {
    const key = r.key?.trim();
    if (!key) continue;
    // `real_value` is the resolved one: Coolify's magic SERVICE_* variables are
    // generated once and kept, and the resolved value is what the container saw.
    const raw = r.real_value ?? r.value;
    if (typeof raw === "string") sawValue = true;
    const value = typeof raw === "string" ? raw : "";
    // The REFERENCE lives on the STORED value: `real_value` is the panel having
    // already resolved it away, so reading the refs off it finds nothing at all
    // on any token that can actually run an import.
    if (typeof r.value === "string" && !r.is_preview)
      sharedRefs.push(...sharedRefsIn([{ key, value: r.value }]));
    if (r.is_preview) {
      previewKeys.push(key);
      previewLines.set(key, `${key}=${serializeValue(value)}`);
      continue;
    }
    // NO value came back for this one (told apart from a value that is empty).
    // One normal variable in the list is enough for `masked` to stay false, so
    // without this the empties are silent.
    if (typeof raw !== "string" || (r.is_shown_once && !value))
      unreadableKeys.push(key);
    // Only with a value: an empty secret could never be filled in, a secret
    // being immutable, where an empty plain variable can.
    if (r.is_shown_once && value) secretKeys.push(key);
    if (r.is_buildtime && !r.is_runtime) buildOnlyKeys.push(key);
    // A shared reference is Coolify's own syntax, resolved above; any other `$`
    // in a non-literal value went through compose's interpolation there.
    if (
      r.is_literal === false &&
      /\$/.test(value) &&
      !/\{\{\s*\w+\.\w+\s*\}\}/.test(r.value ?? "")
    )
      interpolatedKeys.push(key);
    lines.push(`${key}=${serializeValue(value)}`);
  }

  // Coolify keeps a preview twin of every variable; only a key with NO normal
  // row is preview-only, and only that one is worth a line.
  const normal = new Set(lines.map((l) => l.slice(0, l.indexOf("="))));
  const previewOnly = previewKeys.filter((k) => !normal.has(k));
  return {
    blob: lines.join("\n"),
    previewKeys: previewOnly,
    previewBlob: previewOnly.map((k) => previewLines.get(k)!).join("\n"),
    buildOnlyKeys,
    unreadableKeys,
    interpolatedKeys,
    secretKeys,
    sharedRefs,
    masked: rows.length > 0 && !sawValue,
  };
}
