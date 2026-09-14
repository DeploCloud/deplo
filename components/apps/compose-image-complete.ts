import type {
  CompletionContext,
  CompletionResult,
  Completion,
} from "@codemirror/autocomplete";
import { splitForCompletion } from "@/lib/registry/image-ref";

interface TagSuggestion {
  name: string;
  lastUpdated?: string;
}
interface NameSuggestion {
  name: string;
  official?: boolean;
  stars?: number;
}

const IMAGE_LINE = /^(\s*)image\s*:\s*(["']?)([^"'#]*)$/;

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return res.json();
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// imageCompletionSource - completes an `image:` value, else null so other sources run.
export async function imageCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const line = context.state.doc.lineAt(context.pos);
  const beforeCursor = line.text.slice(0, context.pos - line.from);

  const m = IMAGE_LINE.exec(beforeCursor);
  if (!m) return null;

  const value = m[3];
  const valueStart = line.from + (beforeCursor.length - value.length);
  if (!value.trim() && !context.explicit) return null;

  const { namePart, tagPart } = splitForCompletion(value);
  const ac = new AbortController();
  context.addEventListener?.("abort", () => ac.abort());
  const signal = ac.signal;

  try {
    if (tagPart !== null) {
      // Server-side filter so an old version surfaces even when it is not among the newest tags.
      const filterParam = tagPart
        ? `&filter=${encodeURIComponent(tagPart)}`
        : "";
      const json = (await fetchJson(
        `/api/registry/images?action=tags&image=${encodeURIComponent(namePart)}${filterParam}`,
        signal,
      )) as { tags?: TagSuggestion[] } | null;
      const tags = json?.tags ?? [];
      if (tags.length === 0) return null;

      const tagFrom = valueStart + value.length - tagPart.length;
      const options: Completion[] = tags.slice(0, 60).map((t) => ({
        label: t.name,
        type: "constant",
        detail: t.lastUpdated ? relativeDate(t.lastUpdated) : undefined,
      }));
      // filter:false - the registry already matched the fragment server-side, so prefix scoring must not hide them.
      return { from: tagFrom, options, filter: false };
    }

    if (namePart.length < 2) return null;
    const json = (await fetchJson(
      `/api/registry/images?action=search&q=${encodeURIComponent(namePart)}`,
      signal,
    )) as { results?: NameSuggestion[] } | null;
    const names = json?.results ?? [];
    if (names.length === 0) return null;

    const options: Completion[] = names.slice(0, 25).map((n) => ({
      label: n.name,
      // Appending ":" primes a follow-up tag completion.
      apply: `${n.name}:`,
      type: "class",
      detail: n.official
        ? "official"
        : n.stars != null
          ? `★ ${compactNumber(n.stars)}`
          : undefined,
    }));
    // filter:false - Docker Hub already ranked by relevance for the query.
    return { from: valueStart, options, filter: false };
  } catch {
    return null;
  }
}

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
