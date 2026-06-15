"use client";

import * as React from "react";
import Link from "next/link";
import { Search, ArrowUpRight, Star, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn, titleCase } from "@/lib/utils";
import type { CatalogTemplate } from "@/lib/templates";

export function TemplatesBrowser({
  templates,
  tags,
}: {
  templates: CatalogTemplate[];
  tags: string[];
}) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<string>("all");

  const filtered = templates.filter((t) => {
    if (filter === "popular" && !t.popular) return false;
    if (filter !== "all" && filter !== "popular" && !t.tags.includes(filter))
      return false;
    if (query) {
      const q = query.toLowerCase();
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.includes(q))
      );
    }
    return true;
  });

  return (
    <div className="space-y-5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${templates.length} one-click templates…`}
          className="h-10 pl-9"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </Chip>
        <Chip active={filter === "popular"} onClick={() => setFilter("popular")}>
          <Star className="size-3" />
          Popular
        </Chip>
        {tags.map((tag) => (
          <Chip key={tag} active={filter === tag} onClick={() => setFilter(tag)}>
            {titleCase(tag)}
          </Chip>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {filtered.length} {filtered.length === 1 ? "template" : "templates"}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((t) => (
          <Card
            key={t.id}
            className="group relative flex flex-col gap-3 p-5 transition-colors hover:border-foreground/20"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex size-11 items-center justify-center overflow-hidden rounded-lg border border-border bg-white p-1.5">
                {t.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={t.logo}
                    alt={t.name}
                    className="size-full object-contain"
                    loading="lazy"
                  />
                ) : (
                  <span className="text-lg font-semibold text-black">
                    {t.name.slice(0, 1)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {t.popular && (
                  <Badge variant="secondary" className="gap-1">
                    <Star className="size-3" />
                    Popular
                  </Badge>
                )}
                {t.links.github && (
                  <Button
                    asChild
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                  >
                    <a
                      href={t.links.github}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${t.name} on GitHub`}
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  </Button>
                )}
              </div>
            </div>

            <div className="flex-1">
              <h3 className="font-medium">{t.name}</h3>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {t.description}
              </p>
            </div>

            <div className="flex flex-wrap gap-1">
              {t.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>

            <Button asChild size="sm" variant="outline" className="mt-1 w-full">
              <Link href={`/new?template=${t.id}`}>
                Deploy
                <ArrowUpRight className="size-4" />
              </Link>
            </Button>
          </Card>
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No templates match your search.
        </p>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
