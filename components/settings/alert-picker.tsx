"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ALERT_CATEGORIES,
  ALERT_META,
  DEFAULT_ALERTS,
  alertSearchText,
} from "@/lib/alerts";
import { ALL_ALERTS, type AlertKey } from "@/lib/types";

/**
 * Which alerts a team wants — the same picker shape as the role editor's
 * permissions, on purpose: search, categories, a description per row and a
 * count per category. Somebody who has ticked capabilities for a role already
 * knows how this works.
 *
 * Controlled and pure: no fetching, no saving, no dirty state. The caller owns
 * persistence, exactly like `PermissionPicker`.
 */
export function AlertPicker({
  alerts,
  onChange,
  disabled = false,
  hint = "Everything Deplo can tell you about. Tick what is worth interrupting you for - the rest stays in Activity.",
}: {
  alerts: AlertKey[];
  onChange: (next: AlertKey[]) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const [query, setQuery] = React.useState("");
  const enabled = React.useMemo(() => new Set(alerts), [alerts]);

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = React.useCallback(
    (alert: AlertKey) => terms.every((t) => alertSearchText(alert).includes(t)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query],
  );

  // Empty categories vanish while searching rather than sitting there as
  // headings with nothing under them.
  const sections = ALERT_CATEGORIES.map((cat) => ({
    ...cat,
    shown: cat.alerts.filter(matches),
  })).filter((cat) => cat.shown.length > 0);
  const shown = sections.flatMap((c) => c.shown);
  const shownCount = shown.length;

  /** Always emit in catalog order, never insertion order. */
  function write(next: Set<AlertKey>) {
    onChange(ALL_ALERTS.filter((a) => next.has(a)));
  }

  function toggle(alert: AlertKey, on: boolean) {
    if (disabled) return;
    const next = new Set(enabled);
    if (on) next.add(alert);
    else next.delete(alert);
    write(next);
  }

  function setMany(keys: AlertKey[], on: boolean) {
    if (disabled) return;
    const next = new Set(enabled);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    write(next);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {/* The count belongs to the heading, not beside the actions: it says
              what this list currently IS, it is not something you can press. */}
          <h3 className="text-sm font-medium">
            Alerts{" "}
            <span className="font-normal tabular-nums text-muted-foreground">
              ({alerts.length}/{ALL_ALERTS.length})
            </span>
          </h3>
          <InfoTip content={hint} />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {!disabled && (
            <button
              type="button"
              onClick={() => write(new Set(DEFAULT_ALERTS))}
              className="rounded font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Reset to defaults
            </button>
          )}
          {/* Acts on the FILTERED subset and is spelled the same as the control
              in every category header — it is the same gesture, and the same
              gesture cannot be called two things three lines apart. It used to
              say "Clear all" and untick all thirty-two, including the ones the
              search had hidden. */}
          {!disabled && shown.some((a) => enabled.has(a)) && (
            <button
              type="button"
              onClick={() => setMany(shown, false)}
              className="rounded font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Unselect all
            </button>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search alerts"
          aria-label="Search alerts"
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

      {sections.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          No alert matches “{query}”.
        </p>
      ) : (
        <div className="space-y-3">
          {sections.map((cat) => {
            const on = cat.alerts.filter((a) => enabled.has(a)).length;
            // Acts on the FILTERED subset, so "Select all" while searching
            // never quietly ticks a row the user cannot see.
            const allShownOn = cat.shown.every((a) => enabled.has(a));
            return (
              <section
                key={cat.key}
                className="overflow-hidden rounded-lg border border-border"
              >
                <header className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
                  <h4 className="text-sm font-medium">{cat.label}</h4>
                  <Badge
                    variant={on === 0 ? "muted" : "secondary"}
                    className="tabular-nums"
                  >
                    {on}/{cat.alerts.length}
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
                      {allShownOn ? "Unselect all" : "Select all"}
                    </button>
                  )}
                </header>
                <div className="divide-y divide-border/60">
                  {cat.shown.map((alert) => {
                    const meta = ALERT_META[alert];
                    const id = `alert-${alert}`;
                    return (
                      <label
                        key={alert}
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
                          checked={enabled.has(alert)}
                          disabled={disabled}
                          onCheckedChange={(v) => toggle(alert, v === true)}
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium leading-tight">
                            {meta.label}
                          </span>
                          <span className="mt-1 block text-xs leading-snug text-muted-foreground">
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

      {query && shownCount > 0 && (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {shownCount} alert{shownCount === 1 ? "" : "s"} match “{query}”.
        </p>
      )}
    </div>
  );
}
