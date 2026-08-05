"use client";

import * as React from "react";
import { Search, Lock, ShieldAlert, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ALL_CAPABILITIES, type Capability } from "@/lib/types";
import {
  CAPABILITY_CATEGORIES,
  CAPABILITY_META,
  capabilitySearchText,
} from "@/lib/capabilities";

/** Optional permissions = everything except the always-on `view` floor. */
const OPTIONAL = ALL_CAPABILITIES.filter((c) => c !== "view");

/**
 * The permission list shared by the role editor and the API-token editor: every
 * capability deplo enforces, one checkbox each, grouped into categories only so
 * they can be FOUND — there is no category-level grant, because a permission you
 * can only take in a bundle isn't a permission.
 *
 * With forty of them the search box is the primary navigation: it matches the
 * label, the description and a keyword list (so "ssh" finds the console, "api"
 * finds tokens), and hides every category that has no hit.
 */
export function PermissionPicker({
  capabilities,
  onChange,
  disabled = false,
  hint = "Every action deplo can gate, one permission each. Tick exactly what this role should be able to do — search by what you want it to reach.",
  only,
}: {
  capabilities: Capability[];
  onChange: (caps: Capability[]) => void;
  /** Read-only rendering (the locked Owner role, or a viewer). */
  disabled?: boolean;
  /** Tooltip beside the heading — name the thing being granted. */
  hint?: string;
  /**
   * Offer only these, in the same categories. For a set that CAN'T hold every
   * capability: a per-node grant, bounded to `NODE_GRANTABLE_CAPABILITIES`
   * server-side. Showing the rest would offer ticks the save then refuses.
   */
  only?: Capability[];
}) {
  const [query, setQuery] = React.useState("");
  const enabled = React.useMemo(() => new Set(capabilities), [capabilities]);
  // Key the memo on the CONTENTS: the caller passes a fresh array every render,
  // and a new Set each time would re-render every row for nothing.
  const onlyKey = only?.join(",") ?? "";
  const offered = React.useMemo(
    () => (onlyKey ? new Set(onlyKey.split(",") as Capability[]) : null),
    [onlyKey],
  );
  const inScope = React.useCallback(
    (cap: Capability) => !offered || offered.has(cap),
    [offered],
  );

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = React.useCallback(
    (cap: Capability) => {
      if (terms.length === 0) return true;
      const text = capabilitySearchText(cap);
      return terms.every((t) => text.includes(t));
    },
    [terms],
  );

  const sections = CAPABILITY_CATEGORIES.map((cat) => {
    const caps = cat.caps.filter(inScope);
    return { ...cat, caps, shown: caps.filter(matches) };
  }).filter((cat) => cat.shown.length > 0);
  /** The always-on floor is listed like any other permission — it just can't be unticked. */
  const viewShown = matches("view") && inScope("view");
  const shownCount =
    sections.reduce((n, s) => n + s.shown.length, 0) + (viewShown ? 1 : 0);
  const optional = OPTIONAL.filter(inScope);
  const grantedCount = capabilities.filter(
    (c) => c !== "view" && inScope(c),
  ).length;

  function write(next: Set<Capability>) {
    next.add("view");
    onChange(ALL_CAPABILITIES.filter((c) => next.has(c)));
  }

  function toggle(cap: Capability, on: boolean) {
    if (disabled || cap === "view") return;
    const next = new Set(capabilities);
    if (on) next.add(cap);
    else next.delete(cap);
    write(next);
  }

  function setMany(caps: Capability[], on: boolean) {
    if (disabled) return;
    const next = new Set(capabilities);
    for (const c of caps) {
      if (on) next.add(c);
      else next.delete(c);
    }
    write(next);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium">Permissions</h3>
          <InfoTip content={hint} />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {grantedCount} of {optional.length} granted
          </span>
          {!disabled && grantedCount > 0 && (
            <button
              type="button"
              onClick={() => setMany(optional, false)}
              className="rounded font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search permissions"
          aria-label="Search permissions"
          className="pl-9 pr-9"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear the search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {sections.length === 0 && !viewShown ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          No permission matches “{query}”.
        </p>
      ) : (
        <div className="space-y-3">
          {sections.map((cat) => {
            const granted = cat.caps.filter((c) => enabled.has(c)).length;
            const allShownOn = cat.shown.every((c) => enabled.has(c));
            return (
              <section
                key={cat.key}
                className="overflow-hidden rounded-lg border border-border"
              >
                <header className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
                  <h4 className="text-sm font-medium">{cat.label}</h4>
                  <Badge
                    variant={granted === 0 ? "muted" : "secondary"}
                    className="tabular-nums"
                  >
                    {granted}/{cat.caps.length}
                  </Badge>
                  <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">
                    {cat.description}
                  </span>
                  {!disabled && (
                    <button
                      type="button"
                      onClick={() => setMany(cat.shown, !allShownOn)}
                      className="ml-auto shrink-0 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {allShownOn ? "Clear these" : "Select these"}
                    </button>
                  )}
                </header>
                <div className="divide-y divide-border/60">
                  {cat.shown.map((cap) => {
                    const meta = CAPABILITY_META[cap];
                    const id = `perm-${cap}`;
                    return (
                      <label
                        key={cap}
                        htmlFor={id}
                        className={cn(
                          "flex items-start gap-3 px-3 py-2.5 transition-colors",
                          disabled ? "cursor-default" : "cursor-pointer hover:bg-accent",
                        )}
                      >
                        <Checkbox
                          id={id}
                          checked={enabled.has(cap)}
                          disabled={disabled}
                          onCheckedChange={(v) => toggle(cap, v === true)}
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium leading-tight">
                              {meta.label}
                            </span>
                            {meta.sensitive && (
                              <SimpleTooltip content="Sensitive: this one can destroy data or hand over access. Give it deliberately.">
                                <span className="leading-none text-amber-500">
                                  <ShieldAlert
                                    className="size-3.5"
                                    aria-label="Sensitive permission"
                                  />
                                </span>
                              </SimpleTooltip>
                            )}
                          </span>
                          <span className="block text-xs leading-snug text-muted-foreground">
                            {meta.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* view — the floor, last and category-less: same row, permanently ticked. */}
      {viewShown && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-start gap-3 px-3 py-2.5">
            <Checkbox
              checked
              disabled
              aria-label={`${CAPABILITY_META.view.label} — always granted`}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium leading-tight">
                  {CAPABILITY_META.view.label}
                </span>
                <SimpleTooltip content="Always granted: every member can see the team, so this one can't be taken away.">
                  <span className="leading-none text-muted-foreground">
                    <Lock className="size-3.5" aria-label="Always granted" />
                  </span>
                </SimpleTooltip>
              </span>
              <span className="block text-xs leading-snug text-muted-foreground">
                {CAPABILITY_META.view.description}
              </span>
            </span>
          </div>
        </div>
      )}

      {query && shownCount > 0 && (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {shownCount} permission{shownCount === 1 ? "" : "s"} match “{query}”.
        </p>
      )}
    </div>
  );
}
