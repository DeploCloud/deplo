"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ViewToggle, type ListView } from "@/components/shared/view-toggle";

export type AppView = ListView;

export function AppSearch({
  initialQuery,
  initialView,
  initialFolder = "",
  initialProject = "",
  initialEnv = "",
  environmentSwitcher,
}: {
  initialQuery: string;
  initialView: AppView;
  initialFolder?: string;
  initialProject?: string;
  initialEnv?: string;
  environmentSwitcher?: React.ReactNode;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(initialQuery);
  const [view, setView] = React.useState<AppView>(initialView);

  const buildHref = React.useCallback(
    (nextQ: string, nextView: AppView) => {
      const params = new URLSearchParams();
      if (nextQ.trim()) params.set("q", nextQ.trim());
      else if (initialFolder) params.set("folder", initialFolder);
      else if (initialProject) {
        params.set("project", initialProject);
        if (initialEnv) params.set("env", initialEnv);
      }
      if (nextView === "list") params.set("view", "list");
      const qs = params.toString();
      return qs ? `/?${qs}` : "/";
    },
    [initialFolder, initialProject, initialEnv],
  );

  // `view` via ref: a stale closure must not clobber a view chosen mid-debounce.
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

  function selectView(next: AppView) {
    setView(next);
    router.replace(buildHref(q, next));
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search apps"
          className="h-9 pl-9"
        />
      </div>
      {environmentSwitcher}
      <ViewToggle view={view} onView={selectView} className="hidden sm:flex" />
    </div>
  );
}
