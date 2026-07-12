"use client";

import * as React from "react";
import { Container, Check, X, Loader2, Star, Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Docker-image reference input with live, registry-backed hinting.
 *
 * While the user types the repository part we suggest image NAMES (Docker Hub
 * search). Once they type a `:` we switch to suggesting TAGS for that image
 * (works on Docker Hub, GHCR, GitLab, Quay and generic OCI registries). On a
 * complete `image:tag` we validate that it actually resolves and show a status
 * badge. All registry calls go through `/api/registry/images` because the
 * registries don't allow direct browser requests.
 */

interface NameSuggestion {
  name: string;
  description?: string;
  official?: boolean;
  stars?: number;
}
interface TagSuggestion {
  name: string;
  lastUpdated?: string;
}
type Suggestion =
  | { kind: "name"; value: string; data: NameSuggestion }
  | { kind: "tag"; value: string; data: TagSuggestion };

type Existence = "exists" | "absent" | "private" | "unknown";

/** Split input into the name part and the tag fragment after the last `:`. */
function splitForCompletion(input: string): {
  namePart: string;
  tagPart: string | null;
} {
  const noDigest = input.split("@")[0];
  const firstSlash = noDigest.indexOf("/");
  const lastSlash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  const isHostPortColon = colon !== -1 && firstSlash !== -1 && colon < firstSlash;
  if (colon > lastSlash && !isHostPortColon) {
    return { namePart: noDigest.slice(0, colon), tagPart: noDigest.slice(colon + 1) };
  }
  return { namePart: noDigest, tagPart: null };
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export interface ImageInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}

export function ImageInput({
  value,
  onChange,
  placeholder = "ghcr.io/acme/app:latest",
  id,
  className,
}: ImageInputProps) {
  const [open, setOpen] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const [existence, setExistence] = React.useState<Existence | "checking" | null>(
    null,
  );
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const debouncedValue = useDebounced(value, 280);
  // Whether the user is currently completing a tag (after a ":") — drives the
  // empty-state copy and whether we offered name vs tag suggestions.
  const mode = React.useMemo<"name" | "tag">(
    () => (splitForCompletion(value).tagPart !== null ? "tag" : "name"),
    [value],
  );

  // --- Fetch suggestions (name while typing repo, tags after a colon) ---
  React.useEffect(() => {
    const raw = debouncedValue.trim();
    const { namePart, tagPart } = splitForCompletion(raw);
    const controller = new AbortController();

    async function run() {
      if (!raw) {
        setSuggestions([]);
        return;
      }
      setLoading(true);
      try {
        if (tagPart !== null) {
          // Completing a tag — forward the fragment as a server-side filter so a
          // specific/old version surfaces (Docker Hub `name=`), not only newest.
          const filterParam = tagPart
            ? `&filter=${encodeURIComponent(tagPart)}`
            : "";
          const res = await fetch(
            `/api/registry/images?action=tags&image=${encodeURIComponent(namePart)}${filterParam}`,
            { signal: controller.signal },
          );
          const json = await res.json();
          const tags: TagSuggestion[] = json.tags ?? [];
          setSuggestions(
            tags.slice(0, 50).map((t) => ({
              kind: "tag",
              value: `${namePart}:${t.name}`,
              data: t,
            })),
          );
        } else {
          // Completing a name — only Docker Hub returns results; others no-op.
          const res = await fetch(
            `/api/registry/images?action=search&q=${encodeURIComponent(namePart)}`,
            { signal: controller.signal },
          );
          const json = await res.json();
          const names: NameSuggestion[] = json.results ?? [];
          setSuggestions(
            names.map((n) => ({ kind: "name", value: n.name, data: n })),
          );
        }
        setHighlight(0);
      } catch {
        // aborted or failed — leave existing suggestions
      } finally {
        setLoading(false);
      }
    }
    run();
    return () => controller.abort();
  }, [debouncedValue]);

  // --- Validate existence once a full image:tag is present ---
  React.useEffect(() => {
    const raw = debouncedValue.trim();
    const { tagPart } = splitForCompletion(raw);
    // Only validate when there's a concrete tag/digest to check.
    const checkable = raw && !((tagPart === null && !raw.includes("@")) || tagPart === "");
    const controller = new AbortController();

    async function validate() {
      if (!checkable) {
        setExistence(null);
        return;
      }
      setExistence("checking");
      try {
        const res = await fetch(
          `/api/registry/images?action=exists&image=${encodeURIComponent(raw)}`,
          { signal: controller.signal },
        );
        const json = await res.json();
        setExistence((json.status as Existence) ?? "unknown");
      } catch {
        // aborted or failed — leave the previous status
      }
    }
    validate();
    return () => controller.abort();
  }, [debouncedValue]);

  // Close the dropdown on outside click.
  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function choose(s: Suggestion) {
    if (s.kind === "name") {
      // Pick a name → prime a tag completion by appending ":".
      onChange(`${s.value}:`);
      setOpen(true);
    } else {
      onChange(s.value);
      setOpen(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(suggestions[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Container className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={cn("pl-9 pr-9 font-mono text-sm", className)}
      />
      <StatusBadge state={loading ? "checking" : existence} />

      {open && (suggestions.length > 0 || loading || value.trim().length >= 2) && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Searching {mode === "tag" ? "tags" : "registry"}…
            </div>
          )}
          {!loading && suggestions.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {mode === "tag"
                ? "No matching tags found."
                : "No matches on Docker Hub. For other registries, type the full image (e.g. ghcr.io/owner/app) then add a “:” for tags."}
            </div>
          )}
          {suggestions.length > 0 && (
            <ul className="max-h-72 overflow-auto p-1">
              {suggestions.map((s, i) => (
                <li key={`${s.kind}:${s.value}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(s);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                      i === highlight ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-xs">
                        {s.data.name}
                      </span>
                      {s.kind === "name" && s.data.official && (
                        <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">
                          official
                        </span>
                      )}
                    </span>
                    {s.kind === "name" && s.data.stars != null && (
                      <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                        <Star className="size-3" />
                        {compactNumber(s.data.stars)}
                      </span>
                    )}
                    {s.kind === "tag" && s.data.lastUpdated && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {timeAgo(s.data.lastUpdated)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  state,
}: {
  state: Existence | "checking" | null;
}) {
  if (!state) return null;
  const base =
    "pointer-events-none absolute right-3 top-1/2 z-10 -translate-y-1/2";
  if (state === "checking") {
    return <Loader2 className={cn(base, "size-4 animate-spin text-muted-foreground")} />;
  }
  if (state === "exists") {
    return <Check className={cn(base, "size-4 text-[var(--success)]")} />;
  }
  if (state === "private") {
    return <Lock className={cn(base, "size-4 text-muted-foreground")} />;
  }
  if (state === "absent") {
    return <X className={cn(base, "size-4 text-destructive")} />;
  }
  return null;
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
