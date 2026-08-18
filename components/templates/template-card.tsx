import Link from "next/link";
import { Package } from "lucide-react";
import { LogoImage } from "@/components/shared/project-logo";
import { cn } from "@/lib/utils";
import { plateClass, veilProps } from "@/components/templates/veil";
import type { LogoAccent } from "@/lib/templates/logo-color";
import { defaultVariant, type CatalogTemplate } from "@/templates/types";

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
  const variant = defaultVariant(t);
  return {
    slug: t.slug,
    name: t.name,
    shortDescription: variant.shortDescription,
    logo: t.logo,
    category: {
      slug: variant.category.slug,
      name: variant.category.name,
      icon: variant.category.icon,
    },
  };
}

/**
 * One template in the store. The whole card is the link — there is no Deploy
 * button here, because deploying is a decision made on the template's own page,
 * not from a tile that shows two lines about it.
 *
 * `accent` is what its logo's pixels said (see `lib/templates/logo-color.ts`):
 * a hue to wash the card in, or the theme the logo would vanish into. A logo
 * that said neither renders plain, rather than wearing a colour it does not
 * have or a plate it does not need.
 */
export function TemplateCard({
  template,
  accent,
  href,
  className,
}: {
  template: StoreTemplate;
  accent?: LogoAccent;
  href: string;
  className?: string;
}) {
  const veil = veilProps(accent, "hover");
  return (
    <Link
      href={href}
      style={veil.style}
      className={cn(
        "group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors",
        "hover:border-foreground/20 focus-visible:border-foreground/20",
        veil.className,
        className,
      )}
    >
      <LogoImage
        src={template.logo}
        size={56}
        className={cn("tpl-logo", plateClass(accent))}
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
