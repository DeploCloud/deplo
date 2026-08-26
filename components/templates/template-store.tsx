"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { refreshTemplates } from "@/app/(dashboard)/templates/actions";
import { EmptyState } from "@/components/shared/empty-state";
import { DocsLink } from "@/components/ui/docs-link";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CategoryChips } from "@/components/templates/category-chips";
import { NoResultsGraphic } from "@/components/templates/no-results-graphic";
import { StoreRailsSkeleton } from "@/components/templates/store-skeleton";
import { TemplateSearchField } from "@/components/templates/template-search";
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
import type { LogoAccent } from "@/lib/templates/logo-color";
import { titleClass } from "@/components/shared/page-header";

/** A row needs enough cards to be worth scrolling. */
const MIN_RAIL_SIZE = 4;
/** Cards per category row. The rest of a category is one chip away. */
const RAIL_LIMIT = 12;

/** slug → what its logo needs: a hue to wash the card in, a plate to be visible
 *  at all, or nothing. Absent when the logo asked for neither. */
type Accents = Record<string, LogoAccent>;

interface Category {
  slug: string;
  name: string;
  icon: string;
  count: number;
}

export function TemplateStore({
  templates,
  accents,
  placement = null,
  initialQuery,
  initialCategory,
}: {
  /** The catalogue trimmed to what a card draws (see `StoreTemplate`),
   *  asset URLs resolved server-side. */
  templates: StoreTemplate[];
  /**
   * The accents, still in flight: reading them decodes every logo, so they
   * arrive as a promise and only the cards wait behind `<Suspense>`. Never
   * painted uncoloured first - a catalogue that changes shade reads as broken. */
  accents: Promise<Accents>;
  /** The Overview drill-in the store was opened from, carried on to the wizard
   *  so a template deployed from inside a folder is created IN that folder. */
  placement?: OverviewPlacement | null;
  initialQuery: string;
  initialCategory: string;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(initialQuery);
  const [category, setCategory] = React.useState(initialCategory);

  const href = React.useCallback(
    (nextQ: string, nextCategory: string) => {
      const base = templatesHref(placement);
      const params = new URLSearchParams(base.split("?")[1] ?? "");
      if (nextQ.trim()) params.set("q", nextQ.trim());
      if (nextCategory) params.set("category", nextCategory);
      const qs = params.toString();
      return qs ? `/templates?${qs}` : "/templates";
    },
    [placement],
  );

  // The filter lives in the URL so coming back from a template's page restores
  // it. Debounced, or every keystroke would be a history entry.
  const categoryRef = React.useRef(category);
  React.useEffect(() => {
    categoryRef.current = category;
  }, [category]);
  // Guarded on a real keystroke: on mount `q` is already what the URL says, and
  // rewriting it to itself costs a server render on every visit to the store.
  const typed = React.useRef(false);
  React.useEffect(() => {
    if (!typed.current) return;
    const id = setTimeout(() => {
      router.replace(href(q, categoryRef.current), { scroll: false });
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function selectCategory(next: string) {
    setCategory(next);
    router.replace(href(q, next), { scroll: false });
  }

  // Categories the catalogue actually uses, most populated first - derived from
  // the entries rather than fetched, so a chip can never offer an empty filter.
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
      {/* The band: one control, the one every store opens with. */}
      <div className="deplo-grid-bg rounded-xl border border-border px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className={titleClass.page}>Templates</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {templates.length} apps, databases and services, ready to run on
            your own servers. <DocsLink topic="deploy.fromTemplate" />
          </p>
          <div className="mt-5 flex items-center gap-2">
            <TemplateSearchField
              value={q}
              onChange={(next) => {
                typed.current = true;
                setQ(next);
              }}
              className="min-w-0 flex-1"
            />
            <TemplateRefreshButton />
          </div>
        </div>
      </div>

      <CategoryChips
        categories={categories}
        active={category}
        onSelect={selectCategory}
      />

      <React.Suspense fallback={<StoreRailsSkeleton />}>
        <StoreResults
          templates={templates}
          accents={accents}
          categories={categories}
          category={category}
          q={q}
          placement={placement}
        />
      </React.Suspense>
    </div>
  );
}

function TemplateRefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function refresh() {
    startTransition(() =>
      refreshTemplates()
        .then(() => router.refresh())
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not refresh templates",
          );
        }),
    );
  }

  return (
    <SimpleTooltip content="Refresh templates">
      <Button
        variant="outline"
        size="icon"
        aria-label="Refresh templates"
        onClick={refresh}
        disabled={pending}
      >
        <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} />
      </Button>
    </SimpleTooltip>
  );
}

/** The cards: everything that needs a logo accent, and so everything that waits
 *  for one. Split out of {@link TemplateStore} purely to be the child of its
 *  `<Suspense>` - the search field above stays usable while this streams. */
function StoreResults({
  templates,
  accents: pending,
  categories,
  category,
  q,
  placement,
}: {
  templates: StoreTemplate[];
  accents: Promise<Accents>;
  categories: Category[];
  category: string;
  q: string;
  placement: OverviewPlacement | null;
}) {
  const accents = React.use(pending);

  const bySlug = React.useMemo(
    () => new Map(templates.map((t) => [t.slug, t])),
    [templates],
  );

  const query = q.trim().toLowerCase();
  const filtered = React.useMemo(
    () =>
      templates.filter((t) => {
        if (category && t.category.slug !== category) return false;
        if (!query) return true;
        return (
          t.name.toLowerCase().includes(query) ||
          t.shortDescription.toLowerCase().includes(query) ||
          t.category.name.toLowerCase().includes(query)
        );
      }),
    [templates, category, query],
  );

  const browsing = !query && !category;
  // A card keeps the drill-in it was opened from, so the wizard two pages
  // later still creates the App in that folder.
  const scope = templatesHref(placement).split("?")[1] ?? "";
  const cardHref = (slug: string) =>
    scope ? `/templates/${slug}?${scope}` : `/templates/${slug}`;

  const card = (t: StoreTemplate, className?: string) => (
    <TemplateCard
      key={t.slug}
      template={t}
      accent={accents[t.slug]}
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
          <Grid>{[...filtered].sort(byName).map((t) => card(t))}</Grid>
        ) : (
          <EmptyState
            graphic={<NoResultsGraphic />}
            title="No templates match"
            description="Try a different word, or pick another category."
          />
        )}
      </section>
    );

  return (
    <div className="space-y-10">
      {COLLECTIONS.map((collection) => {
        const picks = collection.slugs
          .map((slug) => bySlug.get(slug))
          .filter((t): t is StoreTemplate => Boolean(t));
        if (picks.length < MIN_COLLECTION_SIZE) return null;
        return (
          <TemplateRail
            key={collection.title}
            title={collection.title}
            subtitle={collection.subtitle}
          >
            {picks.map((t) => card(t, "w-56 shrink-0 snap-start"))}
          </TemplateRail>
        );
      })}

      {categories.map((c) => {
        const picks = templates
          .filter((t) => t.category.slug === c.slug)
          .slice(0, RAIL_LIMIT);
        if (picks.length < MIN_RAIL_SIZE) return null;
        return (
          <TemplateRail key={c.slug} title={c.name}>
            {picks.map((t) => card(t, "w-56 shrink-0 snap-start"))}
          </TemplateRail>
        );
      })}

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight lg:text-lg">
            All templates
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything in the catalogue, A to Z.
          </p>
        </div>
        <Grid>{[...templates].sort(byName).map((t) => card(t))}</Grid>
      </section>
    </div>
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
