"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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

export function TemplateSearchLink({
  scope = "",
  className,
}: {
  scope?: string;
  className?: string;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState("");

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
