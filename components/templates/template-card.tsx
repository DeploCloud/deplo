import Link from "@/components/ui/link";
import { cn } from "@/lib/utils";
import { LogoTile } from "@/components/templates/logo-tile";
import { veilProps } from "@/components/templates/veil";
import type { LogoAccent } from "@/lib/templates/logo-color";
import { defaultVariant, type CatalogTemplate } from "@/templates/types";

// StoreTemplate - what a card draws and nothing else: the store is a client component, so an untrimmed catalogue crosses the RSC boundary per entry.
export interface StoreTemplate {
  slug: string;
  name: string;
  shortDescription: string;
  logo: string | null;
  // How many variants the family has: one means Deploy can skip the page.
  variants: number;
  category: { slug: string; name: string; icon: string };
}

export function toStoreTemplate(t: CatalogTemplate): StoreTemplate {
  const variant = defaultVariant(t);
  return {
    slug: t.slug,
    name: t.name,
    shortDescription: variant.shortDescription,
    logo: t.logo,
    variants: t.variants.length,
    category: {
      slug: variant.category.slug,
      name: variant.category.name,
      icon: variant.category.icon,
    },
  };
}

// TemplateCard - the whole card is the link; deploying is decided on the template's own page.
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
      <LogoTile src={template.logo} accent={accent} size={56} logoSize={40} />
      <div className="min-w-0">
        <h3 className="truncate text-sm font-medium">{template.name}</h3>
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {template.shortDescription}
        </p>
      </div>
    </Link>
  );
}
