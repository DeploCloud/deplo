"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, LayoutGrid, List } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ProjectView = "grid" | "list";

export function ProjectSearch({
  initialQuery,
  initialView,
}: {
  initialQuery: string;
  initialView: ProjectView;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(initialQuery);
  const [view, setView] = React.useState<ProjectView>(initialView);

  // Build the dashboard URL from query + view, omitting defaults (empty query,
  // grid view) so the address bar stays clean.
  const buildHref = React.useCallback((nextQ: string, nextView: ProjectView) => {
    const params = new URLSearchParams();
    if (nextQ.trim()) params.set("q", nextQ.trim());
    if (nextView === "list") params.set("view", "list");
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  }, []);

  // Debounce text input -> URL. `view` is read via ref so a stale closure here
  // never clobbers a view chosen mid-debounce.
  const viewRef = React.useRef(view);
  React.useEffect(() => {
    viewRef.current = view;
  }, [view]);
  React.useEffect(() => {
    const id = setTimeout(() => {
      router.replace(buildHref(q, viewRef.current));
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function selectView(next: ProjectView) {
    setView(next);
    router.replace(buildHref(q, next));
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects…"
          className="h-9 pl-9"
        />
      </div>
      <Button
        variant={view === "grid" ? "outline" : "ghost"}
        size="icon"
        className={cn("hidden sm:flex", view !== "grid" && "text-muted-foreground")}
        aria-label="Grid view"
        aria-pressed={view === "grid"}
        onClick={() => selectView("grid")}
      >
        <LayoutGrid className="size-4" />
      </Button>
      <Button
        variant={view === "list" ? "outline" : "ghost"}
        size="icon"
        className={cn("hidden sm:flex", view !== "list" && "text-muted-foreground")}
        aria-label="List view"
        aria-pressed={view === "list"}
        onClick={() => selectView("list")}
      >
        <List className="size-4" />
      </Button>
    </div>
  );
}
