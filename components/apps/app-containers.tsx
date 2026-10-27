"use client";

import * as React from "react";
import { Boxes, ChevronRight, Globe, Logs } from "lucide-react";
import Link from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusDot } from "@/components/shared/status-badge";
import { useAppCan } from "@/components/apps/app-capabilities";
import { useAppRuntime } from "@/components/apps/use-app-runtime";
import {
  containerRows,
  containersSummary,
} from "@/lib/apps/production-summary";
import { plural, sinceShort } from "@/lib/utils";

export function AppContainers({
  appId,
  slug,
  serverName,
}: {
  appId: string;
  slug: string;
  serverName: string | null;
}) {
  const runtime = useAppRuntime(appId);
  const canViewLogs = useAppCan("view_logs");
  const [open, setOpen] = React.useState(false);

  if (!runtime) return <Skeleton className="h-6 w-28" />;

  const summary = containersSummary(runtime);
  const rows = containerRows(runtime);
  const counts = new Map<
    string,
    { dot: (typeof rows)[number]["dot"]; n: number }
  >();
  for (const r of rows) {
    const c = counts.get(r.state);
    if (c) c.n++;
    else counts.set(r.state, { dot: r.dot, n: 1 });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="-mx-1.5 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md bg-surface-strong px-1.5 py-0.5 text-sm hover:bg-accent"
      >
        <Boxes className="size-3.5 shrink-0" />
        <StatusDot status={summary.dot} className="size-2" />
        <span className="truncate">{summary.text}</span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 sm:w-md sm:max-w-[90vw]"
        >
          <div className="space-y-1 border-b border-border p-4 pr-12">
            <SheetTitle>Containers</SheetTitle>
            <SheetDescription>
              Live from {serverName ?? "the app's server"}.
            </SheetDescription>
            {!runtime.unreachable && counts.size > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {[...counts].map(([state, { dot, n }]) => (
                  <Badge key={state} variant="outline" className="gap-1.5">
                    <StatusDot status={dot} className="size-2" />
                    {n} {state.toLowerCase()}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {runtime.unreachable ? (
            <p className="p-4 text-sm text-muted-foreground">
              Can&apos;t reach {serverName ?? "the server"} right now.
            </p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              This app has no containers yet.
            </p>
          ) : (
            <ul className="flex-1 overflow-y-auto">
              {rows.map((r) => (
                <li
                  key={r.key}
                  className="flex items-center gap-3 border-b border-border px-4 py-2.5"
                >
                  <StatusDot status={r.dot} className="size-2" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{r.label}</span>
                      {r.exposed && (
                        <Globe
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-label="Has a domain"
                        />
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {r.state}
                      {r.startedAtUnix > 0 &&
                        ` · up ${sinceShort(r.startedAtUnix * 1000)}`}
                    </p>
                  </div>
                  {r.restarts > 0 && (
                    <Badge variant="warning">
                      {plural(r.restarts, "restart", "restarts")}
                    </Badge>
                  )}
                  {canViewLogs && r.container && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Logs"
                          asChild
                        >
                          <Link
                            href={`/apps/${slug}/logs?container=${encodeURIComponent(r.container)}`}
                          >
                            <Logs className="size-4" />
                          </Link>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Logs</TooltipContent>
                    </Tooltip>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
