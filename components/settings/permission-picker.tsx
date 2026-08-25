"use client";

import * as React from "react";
import { Ban, Search, Lock, ShieldAlert, X } from "lucide-react";
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
 */
export function PermissionPicker({
  capabilities,
  onChange,
  disabled = false,
  hint = "Every action deplo can gate, one permission each. Tick exactly what this role should be able to do — search by what you want it to reach.",
  muted,
  scroll = false,
}: {
  capabilities: Capability[];
  onChange: (caps: Capability[]) => void;
  /** Read-only rendering (the locked Owner role, or a viewer). */
  disabled?: boolean;
  /** Tooltip beside the heading — name the thing being granted. */
  hint?: string;
  /**
   * Bound the category list and scroll it, the way `ScopePicker` bounds its tree.
   */
  scroll?: boolean;
  /**
   * Capabilities the current SCOPE makes meaningless. They stay ticked, stay
   * tickable and keep their value — only the rendering says they do nothing right
   * now, because widening the scope brings them back with no edit to undo.
   */
  muted?: { caps: Capability[]; reason: string };
}) {
  const [query, setQuery] = React.useState("");
  const enabled = React.useMemo(() => new Set(capabilities), [capabilities]);
  // Keyed on the CONTENTS: the caller rebuilds the array every render.
  const mutedKey = muted?.caps.join(",") ?? "";
  const silenced = React.useMemo(
    () => new Set(mutedKey ? (mutedKey.split(",") as Capability[]) : []),
    [mutedKey],
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

  const sections = CAPABILITY_CATEGORIES.map((cat) => ({
    ...cat,
    shown: cat.caps.filter(matches),
  })).filter((cat) => cat.shown.length > 0);
  /** The always-on floor is listed like any other permission — it just can't be unticked. */
  const viewShown = matches("view");
  const shownCount =
    sections.reduce((n, s) => n + s.shown.length, 0) + (viewShown ? 1 : 0);
  const grantedCount = capabilities.filter((c) => c !== "view").length;

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
          <InfoTip content={hint} docs="capabilities.reference" />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {grantedCount} of {OPTIONAL.length} granted
          </span>
          {!disabled && grantedCount > 0 && (
            <button
              type="button"
              onClick={() => setMany(OPTIONAL, false)}
              className="rounded font-medium transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search permissions"
          aria-label="Search permissions"
          className="pr-9 pl-9"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear the search"
            className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
        <div
          className={cn(
            "space-y-3",
            // The scope tree's own `max-h-96`, and a `dvh` ceiling so a short
            // window cannot push the dialog past its 85dvh cap and take the
            // footer with it — which is the whole reason this exists.
            scroll &&
              "focus-safe-scroll max-h-[min(24rem,40dvh)] overflow-y-auto",
          )}
        >
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
                      className="ml-auto shrink-0 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {allShownOn ? "Unselect all" : "Select all"}
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
                          disabled
                            ? "cursor-default"
                            : "cursor-pointer hover:bg-accent",
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
                            <span
                              className={cn(
                                "text-sm leading-tight font-medium",
                                silenced.has(cap) &&
                                  "text-muted-foreground line-through decoration-muted-foreground/60",
                              )}
                            >
                              {meta.label}
                            </span>
                            {silenced.has(cap) && muted && (
                              <SimpleTooltip content={muted.reason}>
                                <span className="leading-none text-muted-foreground">
                                  <Ban
                                    className="size-3.5"
                                    aria-label="Out of reach"
                                  />
                                </span>
                              </SimpleTooltip>
                            )}
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
                    <span className="text-sm leading-tight font-medium">
                      {CAPABILITY_META.view.label}
                    </span>
                    <SimpleTooltip content="Always granted: every member can see the team, so this one can't be taken away.">
                      <span className="leading-none text-muted-foreground">
                        <Lock
                          className="size-3.5"
                          aria-label="Always granted"
                        />
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
