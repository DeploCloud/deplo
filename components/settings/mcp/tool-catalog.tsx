"use client";

import * as React from "react";
import { ChevronRight, Search, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CAPABILITY_META } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import type { Capability } from "@/lib/types/identity";

export interface McpToolSummary {
  name: string;
  title: string;
  description: string;
  group: string;
  requires: string | null;
  destructive: boolean;
}

export function ToolSearch({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search"
        aria-label="Search tools"
        className="pl-9"
      />
    </div>
  );
}

export function ToolCatalog({
  tools,
  query,
  highlight,
}: {
  tools: McpToolSummary[];
  query: string;
  highlight?: string[];
}) {
  const held = React.useMemo(
    () => (highlight ? new Set(highlight) : null),
    [highlight],
  );

  const groups = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? tools.filter(
          (t) =>
            t.name.includes(q) ||
            t.title.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q) ||
            t.group.toLowerCase().includes(q),
        )
      : tools;
    const byGroup = new Map<string, McpToolSummary[]>();
    for (const t of matched) {
      const list = byGroup.get(t.group);
      if (list) list.push(t);
      else byGroup.set(t.group, [t]);
    }
    return [...byGroup.entries()];
  }, [tools, query]);

  const open = query.trim() !== "";
  if (groups.length === 0)
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No tool matches {`"${query}"`}.
      </p>
    );

  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {groups.map(([group, list]) => (
        // a new key re-mounts the group, so a search opens it and clearing closes it
        <details
          key={open ? `${group}:open` : group}
          open={open}
          className="group"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm font-medium transition-colors hover:bg-accent [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
            {group}
            <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
              {list.length}
            </span>
          </summary>
          <div className="divide-y divide-border border-t border-border">
            {list.map((t) => (
              <ToolRow key={t.name} tool={t} held={held} />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function ToolRow({
  tool,
  held,
}: {
  tool: McpToolSummary;
  held: Set<string> | null;
}) {
  const reached =
    held === null ||
    tool.requires === null ||
    (tool.requires !== "instanceAdmin" && held.has(tool.requires));

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 py-3 pr-3 pl-9",
        !reached && "opacity-45",
      )}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 font-mono text-xs">
          {tool.name}
          {tool.destructive && (
            <SimpleTooltip content="Destructive. Your AI client asks before running it.">
              <ShieldAlert className="size-3.5 shrink-0 text-[var(--warning)]" />
            </SimpleTooltip>
          )}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{tool.description}</p>
      </div>
      <div className="shrink-0 pt-0.5 text-right">
        {tool.requires === null ? (
          <span className="text-xs text-muted-foreground">Any token</span>
        ) : tool.requires === "instanceAdmin" ? (
          <Badge variant="outline">Instance admin</Badge>
        ) : (
          <span className="text-xs">
            {CAPABILITY_META[tool.requires as Capability]?.label ??
              tool.requires}
          </span>
        )}
      </div>
    </div>
  );
}
