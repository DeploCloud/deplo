import { KEY_RE, parseEnvFile } from "@/lib/env-file";

// A variable typed or pasted into the list, not saved yet.
export type Draft = {
  id: string;
  key: string;
  value: string;
  note?: string;
  noteLoose?: boolean;
  secret: boolean;
  open: boolean;
};

// What the list already holds under a name: a real variable, or one .env.example asks for.
export type KnownVar = {
  key: string;
  type: "plain" | "secret";
  pending?: boolean;
};

export type DraftTag = "secret-taken" | "fills" | "replaces" | "loose" | null;

let seq = 0;

export function newDraft(patch: Partial<Draft> = {}): Draft {
  seq += 1;
  return {
    id: `draft-${seq}`,
    key: "",
    value: "",
    secret: false,
    open: true,
    ...patch,
  };
}

export function hasContent(d: Draft): boolean {
  return Boolean(d.key.trim() || d.value || d.note?.trim());
}

export function invalidDraft(d: Draft): boolean {
  const key = d.key.trim();
  return key !== "" && !KEY_RE.test(key);
}

export function savableDrafts(drafts: Draft[]): Draft[] {
  return drafts.filter((d) => KEY_RE.test(d.key.trim()));
}

// A pasted .env takes the place of the draft it landed in; a name twice keeps its last line.
export function pasteIntoDrafts(
  drafts: Draft[],
  at: string,
  text: string,
): Draft[] | null {
  const parsed = parseEnvFile(text, { loose: true });
  if (parsed.length === 0) return null;
  const out = drafts.filter((d) => d.id !== at && hasContent(d));
  for (const e of parsed) {
    const draft = newDraft({
      key: e.key,
      value: e.value,
      note: e.note,
      noteLoose: e.noteLoose,
      open: parsed.length === 1,
    });
    const same = out.findIndex((d) => d.key.trim() === e.key);
    if (same >= 0) out[same] = draft;
    else out.push(draft);
  }
  return out;
}

export function draftTag(d: Draft, known: KnownVar[]): DraftTag {
  const hit = known.find((v) => v.key === d.key.trim());
  if (hit?.type === "secret" && !hit.pending) return "secret-taken";
  if (hit?.pending) return "fills";
  if (hit) return "replaces";
  return d.noteLoose && d.note ? "loose" : null;
}
