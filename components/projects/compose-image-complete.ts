import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { splitForCompletion } from "@/lib/registry/image-ref";

/**
 * CodeMirror async completion source for `image:` lines inside the compose
 * editor. When the cursor sits on a service's `image:` value we offer registry
 * suggestions — image NAMES while the repository is being typed, and TAGS once a
 * `:` separates the tag. Backed by the same `/api/registry/images` proxy the
 * standalone image input uses (registries don't allow direct browser calls).
 *
 * This is what makes `image: dxflrs/garage:2.0.|` suggest `2.0.0`, `2.0.1`, …
 * directly in the YAML, instead of only in the Docker-image source tab.
 */

interface TagSuggestion {
  name: string;
  lastUpdated?: string;
}
interface NameSuggestion {
  name: string;
  official?: boolean;
  stars?: number;
}

/** Match the `image:` value on the current line, capturing the value start. */
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

/**
 * The completion source. Returns null when the cursor isn't on an `image:`
 * value (so other completion sources / nothing kicks in), else a CompletionResult
 * whose `from` is the start of the fragment being completed.
 */
export async function imageCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const line = context.state.doc.lineAt(context.pos);
  const beforeCursor = line.text.slice(0, context.pos - line.from);

  const m = IMAGE_LINE.exec(beforeCursor);
  if (!m) return null;

  const value = m[3];
  // Offset (within the doc) where the image value begins: the whole matched
  // prefix length minus the value itself. `beforeCursor` ends at the cursor, so
  // the value runs from here to the cursor.
  const valueStart = line.from + (beforeCursor.length - value.length);
  // Don't fire on an empty value unless the user explicitly invoked completion.
  if (!value.trim() && !context.explicit) return null;

  const { namePart, tagPart } = splitForCompletion(value);
  // Bridge CodeMirror's abort event to a fetch AbortSignal so stale lookups are
  // cancelled when the user keeps typing.
  const ac = new AbortController();
  context.addEventListener?.("abort", () => ac.abort());
  const signal = ac.signal;

  try {
    if (tagPart !== null) {
      // --- Completing a TAG (after the ":") ---
      // Forward the fragment as a server-side filter so a specific/old version
      // (e.g. "2.0") surfaces even when it isn't among the newest tags.
      const filterParam = tagPart ? `&filter=${encodeURIComponent(tagPart)}` : "";
      const json = (await fetchJson(
        `/api/registry/images?action=tags&image=${encodeURIComponent(namePart)}${filterParam}`,
        signal,
      )) as { tags?: TagSuggestion[] } | null;
      const tags = json?.tags ?? [];
      if (tags.length === 0) return null;

      // Replace from just after the tag colon to the cursor.
      const tagFrom = valueStart + value.length - tagPart.length;
      const options: Completion[] = tags.slice(0, 60).map((t) => ({
        label: t.name,
        type: "constant",
        detail: t.lastUpdated ? relativeDate(t.lastUpdated) : undefined,
      }));
      // filter:false — the registry already matched the fragment server-side
      // (e.g. tags are `v2.0.0` while the user typed `2.0.`), so CodeMirror's
      // prefix scoring must not hide them. Order is registry order (newest-first).
      return { from: tagFrom, options, filter: false };
    }

    // --- Completing a NAME (repository) ---
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
    // filter:false — Docker Hub already ranked by relevance for the query.
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
