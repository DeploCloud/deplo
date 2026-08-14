"use client";

import * as React from "react";
import Link from "next/link";
import { Search, ArrowUpRight, ExternalLink, ListFilter } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { newAppHref, type OverviewPlacement } from "@/lib/overview-links";
import type { CatalogTemplate } from "@/templates/types";

export function TemplatesBrowser({
  templates,
  placement = null,
}: {
  /** The whole catalogue, every field the service serves, URL-resolved
   *  server-side — not a trimmed card shape, so anything a card wants to
   *  show (author, links, screenshots, dates) is already here. */
  templates: CatalogTemplate[];
  /** The Overview drill-in the catalogue was opened from — handed to the wizard
   *  so a template deployed from inside a folder is created IN that folder. */
  placement?: OverviewPlacement | null;
}) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<string>("all");

  // Categories the catalogue actually uses, most populated first — the same
  // shape the tag chips had, so the dropdown never offers an empty filter.
  const categories = React.useMemo(() => {
    const counts = new Map<string, { label: string; n: number }>();
    for (const t of templates) {
      const cur = counts.get(t.category.slug);
      counts.set(t.category.slug, {
        label: t.category.name,
        n: (cur?.n ?? 0) + 1,
      });
    }
    return [...counts.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([slug, { label }]) => ({ slug, label }));
  }, [templates]);

  const filtered = templates.filter((t) => {
    if (filter !== "all" && t.category.slug !== filter) return false;
    if (query) {
      const q = query.toLowerCase();
      return (
        t.name.toLowerCase().includes(q) ||
        t.shortDescription.toLowerCase().includes(q) ||
        t.category.name.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        {/* Filter dropdown — the same options the chips used to offer, now a
            single clickable control that sits before the search bar. */}
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger
            className="h-10 w-44 shrink-0"
            aria-label="Filter templates"
          >
            {/* `flex!` is load-bearing: SelectTrigger applies `[&>span]:line-clamp-1`
                to its direct-child spans, whose `display:-webkit-box` outranks a
                plain `flex` class (the `>span` selector is more specific) and
                would stack the icon above the value. The important modifier wins
                it back so the icon and label sit on one row. */}
            <span className="flex! items-center gap-2">
              <ListFilter className="size-4 shrink-0 text-muted-foreground" />
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.slug} value={c.slug}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Search bar with the live template count pinned to its trailing edge. */}
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${templates.length} one-click templates`}
            className="h-10 pl-9 pr-24"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {filtered.length} {filtered.length === 1 ? "template" : "templates"}
          </span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
        {filtered.map((t) => (
          <Card
            key={t.slug}
            className="group relative flex flex-col gap-3 p-5 transition-colors hover:border-foreground/20"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex size-11 items-center justify-center overflow-hidden rounded-lg border border-border p-1.5">
                {t.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={t.logo}
                    alt={t.name}
                    className="size-full object-contain"
                    loading="lazy"
                  />
                ) : (
                  <span className="text-lg font-semibold text-foreground">
                    {t.name.slice(0, 1)}
                  </span>
                )}
              </div>
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

            <div className="flex-1">
              <h3 className="font-medium">{t.name}</h3>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {t.shortDescription}
              </p>
            </div>

            <div className="flex flex-wrap gap-1">
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t.category.name}
              </span>
            </div>

            <Button asChild size="sm" variant="outline" className="mt-1 w-full">
              <Link href={newAppHref(placement, { template: t.slug })}>
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
