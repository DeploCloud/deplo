const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

function quotedMultiline(value: string): string | null {
  const lines = value.split("\n");
  const first = lines[0];
  // parseEnvBlob trims the opening line and closes on the first later line ending in the quote.
  if (first !== first.trimEnd()) return null;
  for (const q of ['"', "'"]) {
    if (first.endsWith(q)) continue;
    if (lines.slice(1, -1).some((l) => l.trimEnd().endsWith(q))) continue;
    return `${q}${value}${q}`;
  }
  return null;
}

function encoded(value: string): string | null {
  if (value.includes("\n")) return quotedMultiline(value);
  if (value === value.trim() && !/^["']/.test(value)) return value;
  return `"${value}"`;
}

// The inverse of parseEnvBlob, for values a person wrote: anything it cannot read back exactly is named, never altered.
export function toEnvBlob(entries: { key: string; value: string }[]): {
  blob: string;
  unrepresentable: string[];
} {
  const lines: string[] = [];
  const unrepresentable: string[] = [];
  for (const { key, value } of entries) {
    const v = KEY_RE.test(key) ? encoded(value) : null;
    if (v === null) unrepresentable.push(key);
    else lines.push(`${key}=${v}`);
  }
  return { blob: lines.join("\n"), unrepresentable };
}
