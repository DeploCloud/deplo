"use client";

import * as React from "react";
import { Search, ShieldAlert, Wrench } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CAPABILITY_META } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import type { Capability } from "@/lib/types";

/**
 * One MCP tool, flattened for the browser.
 *
 * `lib/mcp/tools.ts` is 55 KB of GraphQL documents and zod schemas, and none of
 * it means anything to a reader — so the page derives this on the server and
 * ships only what is rendered. Importing the table into a client component
 * instead would put every tool's query text in the bundle.
 */
export interface McpToolSummary {
  name: string;
  title: string;
  description: string;
  group: string;
  requires: string | null;
  destructive: boolean;
}

/**
 * What an agent can actually do, behind a link.
 *
 * Seventy-eight rows used to sit permanently on this page, which made the
 * screen look like a reference manual for a feature whose entire promise is
 * "copy one line". The list still has to exist — "what am I handing a third
 * party" is a fair question and the honest answer is long — so it lives one
 * click away, and the trigger says the count so nobody has to open it to learn
 * the size of the answer.
 *
 * Search is the primary navigation, as in `PermissionPicker`: with fourteen
 * groups, scrolling to find `app_logs` is worse than typing it. A group with no
 * hit disappears rather than showing an empty heading.
 *
 * `highlight` marks the tools a set of capabilities actually opens. The
 * permissions step passes what is ticked, so the same list answers a different
 * question there — not "what exists" but "what am I about to allow" — without a
 * second component that could drift from this one.
 */
export function ToolsDialog({
  tools,
  highlight,
  trigger,
}: {
  tools: McpToolSummary[];
  /** Capabilities to mark as reached. Omitted ⇒ nothing is marked. */
  highlight?: string[];
  trigger: React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");

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

  const shown = groups.reduce((n, [, list]) => n + list.length, 0);

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        selfManaged
        className="grid h-[min(85vh,44rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-2xl"
      >
        <DialogHeader className="space-y-0 border-b border-border p-6 pb-4">
          <DialogTitle className="text-base lg:text-lg">
            What an agent can do
          </DialogTitle>
          <DialogDescription className="mt-1">
            An agent only sees the tools its token can use. Secrets are never
            readable through any of them.
          </DialogDescription>
          <div className="relative mt-4">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search tools"
              className="pl-9"
            />
          </div>
        </DialogHeader>

        <div className="focus-safe-scroll min-h-0 overflow-y-auto p-6 pt-4">
          {shown === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No tool matches {`"${query}"`}.
            </p>
          ) : (
            <div className="space-y-6">
              {groups.map(([group, list]) => (
                <div key={group}>
                  <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {group}
                  </h3>
                  <div className="mt-2 divide-y divide-border rounded-lg border border-border">
                    {list.map((t) => (
                      <ToolRow key={t.name} tool={t} held={held} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToolRow({
  tool,
  held,
}: {
  tool: McpToolSummary;
  held: Set<string> | null;
}) {
  // `requires: null` is the always-on floor, so it is reached by any token.
  // `instanceAdmin` is not a team capability and can never be in the set.
  const reached =
    held === null ||
    tool.requires === null ||
    (tool.requires !== "instanceAdmin" && held.has(tool.requires));

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 p-3",
        // Dimmed, not hidden: seeing what a wider token would add is half the
        // reason to open this from the permissions step.
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

/** The standing link under the page header: says the size of the answer. */
export function ToolsDialogLink({
  tools,
  className,
}: {
  tools: McpToolSummary[];
  className?: string;
}) {
  return (
    <ToolsDialog
      tools={tools}
      trigger={
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
            className,
          )}
        >
          <Wrench className="size-3.5" />
          {tools.length} tools. See what an agent can do
        </button>
      }
    />
  );
}
