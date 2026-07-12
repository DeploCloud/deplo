import type { EnvVarDTO } from "@/lib/types";

/**
 * Serialise vars to `.env` text. Plain values are shown verbatim; secret values
 * come through as the mask (they are never revealed).
 */
export function serializeEnv(vars: EnvVarDTO[]): string {
  return vars.map((v) => `${v.key}=${v.value}`).join("\n");
}

/**
 * Parse `.env` text into KEY=VALUE pairs (skips blanks/comments; strips one layer
 * of surrounding quotes). Key validation is done server-side. Shared by the app's
 * `.env` editor and the Add-variable modal's paste-`.env` flow.
 */
export function parseEnv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (!key) continue;
    out.push({ key, value });
  }
  return out;
}
