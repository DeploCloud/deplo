"use client";

import { Bone } from "@/components/ui/skeleton";
import * as React from "react";
import { useRouter, useSearchParams } from "@/lib/nav";
import { toast } from "sonner";
import { ArrowRight, RefreshCw } from "lucide-react";
import { gqlAction } from "@/lib/graphql-client";
import { EmptyState } from "@/components/shared/empty-state";
import { DocsLink } from "@/components/ui/docs-link";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CategoryChips } from "@/components/templates/category-chips";
import { CategoryIcon } from "@/components/templates/category-icon";
import { FeaturedTemplates } from "@/components/templates/featured-templates";
import { NoResultsGraphic } from "@/components/templates/no-results-graphic";
import { TemplateSearchField } from "@/components/templates/template-search";
import { TrademarkNote } from "@/components/templates/trademark-note";
import { TemplatesGraphic } from "@/components/templates/templates-graphic";
import { ComposeLaunch } from "@/components/templates/compose-launch";
import {
  TemplateCard,
  type StoreTemplate,
} from "@/components/templates/template-card";
import { TemplateRail } from "@/components/templates/template-rail";
import {
  COLLECTIONS,
  MIN_COLLECTION_SIZE,
} from "@/components/templates/collections";
import { templatesHref, type OverviewPlacement } from "@/lib/overview-links";
import { titleClass } from "@/components/shared/page-header";

const MIN_RAIL_SIZE = 4;
const RAIL_LIMIT = 12;
const GRID_LIMIT = 12;
const RESULTS_PAGE = 48;
const MORE = 48;

interface Category {
  slug: string;
  name: string;
  icon: string;
  count: number;
}

export function TemplateStore({
  templates,
  featured,
  canDeploy,
  placement = null,
}: {
  templates: StoreTemplate[];
  featured: StoreTemplate[];
  canDeploy: boolean;
  placement?: OverviewPlacement | null;
}) {
  const searchParams = useSearchParams();
  const [q, setQ] = React.useState(() => searchParams.get("q") ?? "");
  const [category, setCategory] = React.useState(
    () => searchParams.get("category") ?? "",
  );

  // The address follows the filters without asking the server again.
  React.useEffect(() => {
    const id = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of [
        ["q", q.trim()],
        ["category", category],
      ] as const)
        if (value) params.set(key, value);
        else params.delete(key);
      const next = params.toString();
      if (next !== window.location.search.slice(1))
        window.history.replaceState(
          null,
          "",
          next ? `?${next}` : window.location.pathname,
        );
    }, 250);
    return () => clearTimeout(id);
  }, [q, category]);

  // Typing stays instant while the results catch up.
  const deferredQ = React.useDeferredValue(q);
  const deferredCategory = React.useDeferredValue(category);

  const categories = React.useMemo<Category[]>(() => {
    const seen = new Map<string, Category>();
    for (const t of templates) {
      const cur = seen.get(t.category.slug);
      if (cur) cur.count += 1;
      else
        seen.set(t.category.slug, {
          slug: t.category.slug,
          name: t.category.name,
          icon: t.category.icon,
          count: 1,
        });
    }
    return [...seen.values()].sort((a, b) => b.count - a.count);
  }, [templates]);

  return (
    <div className="space-y-8">
      <StoreHero
        count={templates.length}
        query={q}
        onQuery={setQ}
        canDeploy={canDeploy}
      />

      <CategoryChips
        categories={categories}
        active={category}
        onSelect={setCategory}
      />

      <StoreResults
        templates={templates}
        featured={featured}
        categories={categories}
        category={deferredCategory}
        q={deferredQ}
        canDeploy={canDeploy}
        placement={placement}
        onSelectCategory={setCategory}
      />

      <TrademarkNote />
    </div>
  );
}

function TemplateRefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function refresh() {
    startTransition(async () => {
      const res = await gqlAction(/* GraphQL */ `
        mutation RefreshTemplates {
          refreshTemplates
        }
      `);
      if (res.ok) router.refresh();
      else toast.error(res.error);
    });
  }

  return (
    <SimpleTooltip content="Refresh templates">
      <Button
        variant="outline"
        size="icon"
        aria-label="Refresh templates"
        className="size-10 shrink-0"
        onClick={refresh}
        disabled={pending}
      >
        <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} />
      </Button>
    </SimpleTooltip>
  );
}

const StoreResults = React.memo(function StoreResults({
  templates,
  featured,
  categories,
  category,
  q,
  canDeploy,
  placement,
  onSelectCategory,
}: {
  templates: StoreTemplate[];
  featured: StoreTemplate[];
  categories: Category[];
  category: string;
  q: string;
  canDeploy: boolean;
  placement: OverviewPlacement | null;
  onSelectCategory: (slug: string) => void;
}) {
  const bySlug = React.useMemo(
    () => new Map(templates.map((t) => [t.slug, t])),
    [templates],
  );
  const sorted = React.useMemo(() => [...templates].sort(byName), [templates]);

  const query = q.trim().toLowerCase();
  const filtered = React.useMemo(
    () =>
      sorted.filter((t) => {
        if (category && t.category.slug !== category) return false;
        if (!query) return true;
        return (
          t.name.toLowerCase().includes(query) ||
          t.shortDescription.toLowerCase().includes(query) ||
          t.category.name.toLowerCase().includes(query)
        );
      }),
    [sorted, category, query],
  );

  const browsing = !query && !category;
  const scope = templatesHref(placement).split("?")[1] ?? "";
  const cardHref = (slug: string) =>
    scope ? `/templates/${slug}?${scope}` : `/templates/${slug}`;

  const card = (t: StoreTemplate, className?: string) => (
    <TemplateCard
      key={t.slug}
      template={t}
      href={cardHref(t.slug)}
      className={className}
    />
  );

  if (!browsing)
    return (
      <section className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "template" : "templates"}
        </p>
        {filtered.length ? (
          <PagedGrid
            key={`${category} ${query}`}
            items={filtered}
            first={RESULTS_PAGE}
            card={card}
          />
        ) : (
          <EmptyState
            graphic={<NoResultsGraphic />}
            title="No templates match"
            description="Try a different word, or pick another category."
          />
        )}
      </section>
    );

  const featuredSlugs = new Set(featured.map(({ slug }) => slug));

  return (
    <div className="space-y-10">
      <FeaturedTemplates
        templates={featured}
        canDeploy={canDeploy}
        placement={placement}
      />

      {COLLECTIONS.map((collection) => {
        const picks = collection.slugs
          .filter((slug) => !featuredSlugs.has(slug))
          .map((slug) => bySlug.get(slug))
          .filter((t): t is StoreTemplate => Boolean(t));
        if (picks.length < MIN_COLLECTION_SIZE) return null;
        return (
          <TemplateRail
            key={collection.title}
            title={collection.title}
            subtitle={collection.subtitle}
          >
            {picks.map((t) => card(t, "w-72 shrink-0 snap-start"))}
          </TemplateRail>
        );
      })}

      <div className="flex items-center gap-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Browse by category
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {categories.map((c) => {
        const picks = templates
          .filter((t) => t.category.slug === c.slug)
          .slice(0, RAIL_LIMIT);
        if (picks.length < MIN_RAIL_SIZE) return null;
        return (
          <TemplateRail
            key={c.slug}
            title={c.name}
            icon={
              <CategoryIcon
                icon={c.icon}
                className="size-4 text-muted-foreground"
              />
            }
            action={
              c.count > picks.length ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => onSelectCategory(c.slug)}
                >
                  See all {c.count}
                  <ArrowRight className="size-4" />
                </Button>
              ) : undefined
            }
          >
            {picks.map((t) => card(t, "w-56 shrink-0 snap-start"))}
          </TemplateRail>
        );
      })}

      <section className="space-y-3">
        <div>
          <h2 className={titleClass.section}>
            All templates{" "}
            <span className="font-normal text-muted-foreground">
              {templates.length}
            </span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything in the catalogue, A to Z.
          </p>
        </div>
        <PagedGrid items={sorted} first={GRID_LIMIT} card={card} />
      </section>
    </div>
  );
});

// Cards arrive a page at a time: a grid of the whole catalogue is what made the store slow.
function PagedGrid({
  items,
  first,
  card,
}: {
  items: StoreTemplate[];
  first: number;
  card: (t: StoreTemplate) => React.ReactNode;
}) {
  const [shown, setShown] = React.useState(first);
  const rest = items.length - shown;
  return (
    <>
      <Grid>{items.slice(0, shown).map((t) => card(t))}</Grid>
      {rest > 0 && (
        <div className="flex justify-center pt-1">
          <Button variant="outline" onClick={() => setShown(shown + MORE)}>
            Show {Math.min(rest, MORE)} more
          </Button>
        </div>
      )}
    </>
  );
}

function byName(a: StoreTemplate, b: StoreTemplate) {
  return a.name.localeCompare(b.name);
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {children}
    </div>
  );
}

/** The store's heading, search and compose entry; `loading` keeps it inert with the count unknown. */
export function StoreHero({
  count,
  query,
  onQuery,
  canDeploy,
  loading = false,
}: {
  count: number;
  query: string;
  onQuery: (next: string) => void;
  canDeploy: boolean;
  loading?: boolean;
}) {
  return (
    <section className="relative grid items-center gap-8 pt-8 sm:pt-12 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div
        aria-hidden
        className="pointer-events-none hidden lg:order-last lg:block"
      >
        <TemplatesGraphic className="h-auto w-full" />
      </div>
      <div className="relative min-w-0" inert={loading || undefined}>
        <h1 className="text-3xl font-semibold tracking-tight">Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <Bone loading={loading}>{count}</Bone> apps, databases and services,
          ready to run on your own servers.{" "}
          <DocsLink topic="deploy.fromTemplate" />
        </p>
        <div className="mt-5 flex max-w-md items-center gap-2">
          <TemplateSearchField
            value={query}
            onChange={onQuery}
            className="min-w-0 flex-1"
          />
          <TemplateRefreshButton />
        </div>
        <Bone box loading={loading} className="mt-3">
          <ComposeLaunch
            canDeploy={canDeploy}
            className={loading ? undefined : "mt-3"}
          />
        </Bone>
      </div>
    </section>
  );
}
