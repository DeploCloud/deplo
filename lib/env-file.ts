export const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

export const NOTE_MAX = 1000;

export interface EnvFileEntry {
  key: string;
  value: string;
  // The comment above the line, or after its value.
  note?: string;
  noteCut?: true;
  // The note sat behind a blank line: only kept when asked for, and worth a second look.
  noteLoose?: true;
}

const SINGLE_QUOTED = /^(["'])(.*?)\1\s*(?:#(.*))?$/;
const WORDY = /[\p{L}\p{N}]/u;
// `--- Database ---`, `=== Email`: a section title, never a note.
const HEADING = /^[-=*~_]{2,}|[-=*~_]{2,}$/;

// Each line folds its own whitespace; the line breaks stay.
export function cleanNote(raw: string | null | undefined): string | null {
  const note = (raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return note || null;
}

// A typed note over the limit is refused, never cut: only a pasted comment is shortened.
export function noteInput(raw: string | null | undefined): string | null {
  const note = cleanNote(raw);
  if (note && note.length > NOTE_MAX)
    throw new Error(`A note can be at most ${NOTE_MAX} characters.`);
  return note;
}

function commentText(raw: string | undefined): string {
  const text = (raw ?? "").replace(/^#+/, "").trim();
  return WORDY.test(text) ? text : "";
}

function noteOf(
  inline: string | undefined,
  lines: string[],
): Pick<EnvFileEntry, "note" | "noteCut"> {
  const note = cleanNote(commentText(inline) || lines.join("\n"));
  if (!note) return {};
  return note.length > NOTE_MAX
    ? { note: note.slice(0, NOTE_MAX).trimEnd(), noteCut: true }
    : { note };
}

// The one .env reader: the paste box, importEnv, .env.example and the migration importers.
// see https://deplo.build/docs/guides/config/environment-variables#add-a-note
export function parseEnvFile(
  text: string | null | undefined,
  { loose = false }: { loose?: boolean } = {},
): EnvFileEntry[] {
  if (!text) return [];
  const out: EnvFileEntry[] = [];
  const at = new Map<string, number>();
  const lines = text.split("\n");
  let above: string[] = [];
  let behindBlank: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().replace(/^export\s+/, "");
    if (line.startsWith("#")) {
      const text = commentText(line);
      if (HEADING.test(text)) {
        above = [];
        behindBlank = [];
      } else if (text) above.push(text);
      continue;
    }
    const eq = line.indexOf("=");
    const key = eq === -1 ? "" : line.slice(0, eq).trim();
    if (!key) {
      if (above.length) behindBlank = above;
      above = [];
      continue;
    }
    const raw = line.slice(eq + 1);
    const rest = raw.trim();
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : "";
    const single = quote ? rest.match(SINGLE_QUOTED) : null;
    // An unquoted `#` is a comment only after whitespace, so `COLOR=#fff` survives.
    const hash = single ? null : raw.match(/\s+#(.*)$/);
    let value = single
      ? single[2]
      : (hash ? raw.slice(0, hash.index) : raw).trim();
    let inline = single ? single[3] : hash?.[1];
    if (quote && !single) {
      const close = new RegExp(`${quote}\\s*(?:#(.*))?$`);
      const end = lines.findIndex((l, j) => j > i && close.test(l.trimEnd()));
      if (end !== -1) {
        const last = lines[end].trimEnd();
        const closing = last.match(close)!;
        value = [
          rest.slice(1),
          ...lines.slice(i + 1, end),
          last.slice(0, closing.index),
        ].join("\n");
        inline = closing[1];
        i = end;
      }
    }
    const far = loose && !above.length && !commentText(inline);
    const entry: EnvFileEntry = {
      key,
      value,
      ...noteOf(inline, far ? behindBlank : above),
    };
    if (far && entry.note) entry.noteLoose = true;
    above = [];
    behindBlank = [];
    const seen = at.get(key);
    if (seen === undefined) {
      at.set(key, out.length);
      out.push(entry);
    } else out[seen] = entry;
  }
  return out;
}
