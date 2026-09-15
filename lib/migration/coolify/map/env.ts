import { parseEnvBlob, sharedRefsIn } from "../../map/env";
import type { SharedRef } from "../../map/env";
import type { CoolifyEnv } from "../client";

export interface CoolifyEnvRead {
  blob: string;
  previewKeys: string[];
  previewBlob: string;
  buildOnlyKeys: string[];
  sharedRefs: SharedRef[];
  masked: boolean;
  unreadableKeys: string[];
  interpolatedKeys: string[];
  secretKeys: string[];
}

function serializeValue(value: string): string {
  if (!value.includes("\n")) return value;
  for (const q of ["'", '"'])
    if (value.startsWith(q) && value.endsWith(q)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return value;
}

export function withoutPanelInternals(blob: string): string {
  const entries = parseEnvBlob(blob);
  const kept = entries.filter(({ key }) => !/^COOLIFY_/i.test(key.trim()));
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
    const raw = r.real_value ?? r.value;
    if (typeof raw === "string") sawValue = true;
    const value = typeof raw === "string" ? raw : "";
    if (typeof r.value === "string" && !r.is_preview)
      sharedRefs.push(...sharedRefsIn([{ key, value: r.value }]));
    if (r.is_preview) {
      previewKeys.push(key);
      previewLines.set(key, `${key}=${serializeValue(value)}`);
      continue;
    }
    if (typeof raw !== "string" || (r.is_shown_once && !value))
      unreadableKeys.push(key);
    if (r.is_shown_once && value) secretKeys.push(key);
    if (r.is_buildtime && !r.is_runtime) buildOnlyKeys.push(key);
    if (
      r.is_literal === false &&
      /\$/.test(value) &&
      !/\{\{\s*\w+\.\w+\s*\}\}/.test(r.value ?? "")
    )
      interpolatedKeys.push(key);
    lines.push(`${key}=${serializeValue(value)}`);
  }

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
