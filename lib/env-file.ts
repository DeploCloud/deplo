export const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

export interface EnvFileEntry {
  key: string;
  value: string;
}

const SINGLE_QUOTED = /^(["'])(.*?)\1\s*(?:#.*)?$/;

// The one .env reader: the paste box, importEnv and the migration importers all go through it.
export function parseEnvFile(text: string | null | undefined): EnvFileEntry[] {
  if (!text) return [];
  const out: EnvFileEntry[] = [];
  const at = new Map<string, number>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    const raw = line.slice(eq + 1);
    const rest = raw.trim();
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : "";
    const single = quote ? rest.match(SINGLE_QUOTED) : null;
    // An unquoted `#` is a comment only after whitespace, so `COLOR=#fff` survives.
    let value = single ? single[2] : raw.replace(/\s+#.*$/, "").trim();
    if (quote && !single) {
      const close = new RegExp(`${quote}\\s*(?:#.*)?$`);
      const end = lines.findIndex((l, j) => j > i && close.test(l.trimEnd()));
      if (end !== -1) {
        const last = lines[end].trimEnd();
        value = [
          rest.slice(1),
          ...lines.slice(i + 1, end),
          last.slice(0, last.search(close)),
        ].join("\n");
        i = end;
      }
    }
    const seen = at.get(key);
    if (seen === undefined) {
      at.set(key, out.length);
      out.push({ key, value });
    } else out[seen] = { key, value };
  }
  return out;
}
