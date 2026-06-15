"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, LayoutGrid, List } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ProjectSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [q, setQ] = React.useState(initialQuery);

  React.useEffect(() => {
    const id = setTimeout(() => {
      router.replace(q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : "/");
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

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
      <Button variant="outline" size="icon" className="hidden sm:flex" aria-label="Grid view">
        <LayoutGrid className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="hidden text-muted-foreground sm:flex"
        aria-label="List view"
      >
        <List className="size-4" />
      </Button>
    </div>
  );
}
