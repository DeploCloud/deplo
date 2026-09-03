"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The store's search box. The catalogue drives it itself, filtering 388 entries
 * in memory on every keystroke; a single template's page uses
 * `TemplateSearchLink` below, which navigates. */
export function TemplateSearchField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search templates"
        aria-label="Search templates"
        className="h-10 bg-background pl-9"
      />
    </div>
  );
}

/**
 * The same box on a template's page, so search never disappears once you have
 * drilled in. It `push`es rather than `replace`s: leaving a template's page IS
 * a navigation, and Back has to return to what you were reading. */
export function TemplateSearchLink({
  scope = "",
  className,
}: {
  /** The drill-in query string (`folder=…` / `project=…&env=…`) to preserve. */
  scope?: string;
  className?: string;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState("");

  // Nothing happens until the box is actually typed in - a bare mount must not
  // navigate away from the page that just rendered.
  const typed = React.useRef(false);
  React.useEffect(() => {
    if (!typed.current) return;
    const id = setTimeout(() => {
      const params = new URLSearchParams(scope);
      if (q.trim()) params.set("q", q.trim());
      const qs = params.toString();
      router.push(qs ? `/templates?${qs}` : "/templates");
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <TemplateSearchField
      value={q}
      onChange={(next) => {
        typed.current = true;
        setQ(next);
      }}
      className={className}
    />
  );
}
