import { ArrowUpRight } from "lucide-react";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CategoryIcon } from "@/components/templates/category-icon";
import { LogoTile } from "@/components/templates/logo-tile";
import { veilProps } from "@/components/templates/veil";
import type { StoreTemplate } from "@/components/templates/template-card";
import type { LogoAccent } from "@/lib/templates/logo-color";
import { titleClass } from "@/components/shared/page-header";
import {
  newAppHref,
  templateHref,
  type OverviewPlacement,
} from "@/lib/overview-links";
import { cn } from "@/lib/utils";

/**
 * The storefront: one template the eye lands on and six smaller ones beside it.
 * Deploy skips the page only for a family with a single variant - with more, the
 * choice is made on the template's own page.
 */
export function FeaturedTemplates({
  templates,
  accents,
  canDeploy,
  placement,
}: {
  templates: StoreTemplate[];
  accents: Record<string, LogoAccent>;
  canDeploy: boolean;
  placement: OverviewPlacement | null;
}) {
  const [hero, ...rest] = templates;
  if (!hero) return null;

  return (
    <section className="space-y-3">
      <h2 className={titleClass.section}>Featured</h2>
      <div className="grid gap-3 xl:grid-cols-3">
        <Hero
          template={hero}
          accent={accents[hero.slug]}
          canDeploy={canDeploy}
          placement={placement}
        />
        {/* Two of the three columns, three cards deep each. Below xl the pair
            drops under the hero rather than squeezing beside it. */}
        <div className="grid gap-3 sm:grid-cols-2 xl:col-span-2">
          {rest.map((t) => (
            <Sidekick
              key={t.slug}
              template={t}
              accent={accents[t.slug]}
              placement={placement}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function Hero({
  template,
  accent,
  canDeploy,
  placement,
}: {
  template: StoreTemplate;
  accent?: LogoAccent;
  canDeploy: boolean;
  placement: OverviewPlacement | null;
}) {
  const veil = veilProps(accent, "on");
  const page = templateHref(template.slug, placement);
  // A family with one variant has nothing to choose, so Deploy opens the wizard;
  // with more, the variant is a decision and it is made on the template's page.
  const deploy =
    template.variants > 1
      ? page
      : newAppHref(placement, { template: template.slug, variant: "default" });

  return (
    <div
      style={veil.style}
      className={cn(
        "flex flex-col justify-between gap-5 rounded-xl border border-border bg-card p-5",
        veil.className,
      )}
    >
      <Link href={page} className="group flex flex-col gap-4">
        <LogoTile
          src={template.logo}
          accent={accent}
          size={80}
          logoSize={56}
          className="rounded-2xl"
        />
        <div className="min-w-0">
          <h3 className="truncate text-xl font-semibold tracking-tight group-hover:underline">
            {template.name}
          </h3>
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {template.shortDescription}
          </p>
        </div>
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CategoryIcon icon={template.category.icon} className="size-4" />
          {template.category.name}
        </span>
        {canDeploy ? (
          <Button asChild className="w-32">
            <Link href={deploy}>
              Deploy
              <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        ) : (
          // A disabled button swallows pointer events, so the tooltip needs a
          // focusable wrapper to stay reachable.
          <SimpleTooltip content="Needs the “Create apps” permission">
            <span tabIndex={0}>
              <Button disabled className="w-32">
                Deploy
                <ArrowUpRight className="size-4" />
              </Button>
            </span>
          </SimpleTooltip>
        )}
      </div>
    </div>
  );
}

function Sidekick({
  template,
  accent,
  placement,
}: {
  template: StoreTemplate;
  accent?: LogoAccent;
  placement: OverviewPlacement | null;
}) {
  const veil = veilProps(accent, "hover");
  return (
    <Link
      href={templateHref(template.slug, placement)}
      style={veil.style}
      className={cn(
        "flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors",
        "hover:border-foreground/20 focus-visible:border-foreground/20",
        veil.className,
      )}
    >
      <LogoTile src={template.logo} accent={accent} size={48} logoSize={32} />
      <div className="min-w-0">
        <h3 className="truncate text-sm font-medium">{template.name}</h3>
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {template.shortDescription}
        </p>
      </div>
    </Link>
  );
}
