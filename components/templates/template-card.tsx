import Link from "next/link";
import { Package } from "lucide-react";
import { LogoImage } from "@/components/shared/project-logo";
import { cn } from "@/lib/utils";
import type { CatalogTemplate } from "@/templates/types";

/**
 * What the browser needs to draw a template, and nothing else.
 *
 * `listCatalog()` returns the whole entry — long description, links, author,
 * dates, blueprint paths — and the store is a client component, so an untrimmed
 * catalogue crosses the RSC boundary 388 times over: 368 KB against 103 KB
 * measured on the live catalogue. Everything left out is fetched by
 * `/templates/[slug]`, which is the page that shows it. (ADR-0023 §3.)
 */
export interface StoreTemplate {
  slug: string;
  name: string;
  shortDescription: string;
  logo: string | null;
  category: { slug: string; name: string; icon: string };
}

export function toStoreTemplate(t: CatalogTemplate): StoreTemplate {
  return {
    slug: t.slug,
    name: t.name,
    shortDescription: t.shortDescription,
    logo: t.logo,
    category: {
      slug: t.category.slug,
      name: t.category.name,
      icon: t.category.icon,
    },
  };
}

/**
 * One template in the store. The whole card is the link — there is no Deploy
 * button here, because deploying is a decision made on the template's own page,
 * not from a tile that shows two lines about it.
 *
 * `hue` is the dominant hue of the logo (see `lib/templates/logo-color.ts`).
 * When there isn't one the veil classes are left off entirely and the card
 * renders plain, rather than wearing a colour its logo does not have.
 */
export function TemplateCard({
  template,
  hue,
  href,
  className,
}: {
  template: StoreTemplate;
  hue?: number;
  href: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      style={hue === undefined ? undefined : ({ "--tpl-hue": hue } as React.CSSProperties)}
      className={cn(
        "group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors",
        "hover:border-foreground/20 focus-visible:border-foreground/20",
        hue !== undefined && "tpl-veil tpl-veil-hover",
        className,
      )}
    >
      <LogoImage
        src={template.logo}
        size={56}
        fallback={<Package className="size-6 text-muted-foreground" />}
      />
      <div className="min-w-0">
        <h3 className="truncate text-sm font-medium">{template.name}</h3>
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {template.shortDescription}
        </p>
      </div>
    </Link>
  );
}
