"use client";

import * as React from "react";
import { AppLogo } from "@/components/shared/project-logo";
import { CheckMark } from "@/components/shared/choice-card";
import { cn } from "@/lib/utils";
import type { AppRef } from "./types";
import { PickerSearch } from "./picker-search";

export function AppsSection({
  apps,
  selected,
  onChange,
}: {
  apps: AppRef[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [q, setQ] = React.useState("");
  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter((a) =>
      `${a.name} ${a.slug} ${a.primaryDomain ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [apps, q]);

  function toggle(id: string) {
    onChange(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );
  }

  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-sm font-medium">Apps</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick the apps to add this variable to - it reaches them on their next
          deploy. {selected.length > 0 && `${selected.length} selected.`}
        </p>
      </div>
      <PickerSearch
        value={q}
        onChange={setQ}
        placeholder="Search apps by name or domain"
        label="Search apps"
      />
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {q.trim()
            ? `No app matches “${q.trim()}”.`
            : "This team has no apps yet."}
        </p>
      ) : (
        <div role="group" aria-label="Apps" className="grid grid-cols-1 gap-2">
          {shown.map((a) => {
            const on = selected.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(a.id)}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
                  on
                    ? "border-primary bg-primary-wash ring-1 ring-primary/60"
                    : "border-border hover:border-foreground/20 hover:bg-surface",
                )}
              >
                <AppLogo logo={a.logo} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {a.name}
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {a.primaryDomain ?? `${a.slug} · no domain yet`}
                  </span>
                </span>
                <CheckMark selected={on} />
              </button>
            );
          })}
        </div>
      )}
      {selected.length === 0 && (
        <p className="text-xs text-muted-foreground">Pick at least one app.</p>
      )}
    </section>
  );
}
