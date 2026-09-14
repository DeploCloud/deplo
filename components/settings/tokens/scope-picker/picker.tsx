"use client";

import * as React from "react";
import { AlertTriangle, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InfoTip } from "@/components/ui/info-tip";
import type { DocsTopic } from "@/lib/docs";
import type { ScopeTreeTeam } from "@/lib/data/tokens/scope-tree";
import type { ScopeNode, ScopeSelection } from "./selection";
import { ScopeTree } from "./tree";
import { useScopePicker } from "./use-scope-picker";

// ScopePicker - what an API token may reach, as the tree it actually is.
export function ScopePicker({
  tree,
  selection,
  onChange,
  disabled = false,
  info = "What this token can reach. Tick a team for all of it, a project or a folder for everything inside it, or single apps. Tick nothing and it reaches everything you can.",
  docs = "tokens.scope",
  emptyNote = "You aren't in any team yet, so there is nothing to narrow this token to.",
  notice,
  renderMeta,
  teamPickable = true,
}: {
  tree: ScopeTreeTeam[];
  selection: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  disabled?: boolean;
  // A team checkbox is a second way to say "no limit", which is what ticking
  // nothing already says.
  teamPickable?: boolean;
  info?: React.ReactNode;
  docs?: DocsTopic;
  emptyNote?: React.ReactNode;
  notice?: React.ReactNode;
  // An extra control on the right of a row. Rendered OUTSIDE the row's `<label>`,
  // so clicking it doesn't toggle the checkbox next to it.
  renderMeta?: (node: ScopeNode) => React.ReactNode;
}) {
  const state = useScopePicker({
    tree,
    selection,
    onChange,
    disabled,
    teamPickable,
  });
  const { query, setQuery, shown, allOn, tickAll } = state;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-medium">Access</h3>
        <InfoTip content={info} docs={docs} />
        {tree.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => tickAll(!allOn)}
            className="ml-auto h-7 text-xs"
          >
            {allOn ? "Unselect all" : "Select all"}
          </Button>
        )}
      </div>

      {tree.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyNote}</p>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search teams, projects, folders and apps"
              aria-label="Search what this can access"
              className="pr-9 pl-9"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear the search"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {notice && (
            <div className="flex items-start gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--warning)]" />
              <div className="min-w-0 text-sm">{notice}</div>
            </div>
          )}

          {shown.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing matches &ldquo;{query}&rdquo;.
            </div>
          ) : (
            <ScopeTree
              state={state}
              disabled={disabled}
              teamPickable={teamPickable}
              environmentsExpressible={selection.environmentIds !== undefined}
              renderMeta={renderMeta}
            />
          )}
        </>
      )}
    </div>
  );
}
