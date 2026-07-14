/**
 * Parse `.env` text into KEY=VALUE pairs (skips blanks/comments; strips one layer
 * of surrounding quotes). Key validation is done server-side. Feeds the
 * Add-variable modal's paste-a-`.env` flow.
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
