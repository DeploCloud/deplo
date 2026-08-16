import Link from "next/link";
import { Package } from "lucide-react";
import { LogoImage } from "@/components/shared/project-logo";
import { cn } from "@/lib/utils";
import type { LogoAccent } from "@/lib/templates/logo-color";
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

/**
 * The wash a logo's card wears, and the one number it needs.
 *
 * A logo with a hue wears that hue. A logo drawn in a single neutral has no
 * hue, so it wears its own ink instead (`tpl-veil-neutral`) — a white wordmark
 * lights its card white rather than being the one tile in the grid that stays
 * flat. A logo that read as neither renders plain.
 *
 * `lit` picks when: `"hover"` on the cards, `"on"` for the detail page's header.
 */
export function veilProps(
  accent: LogoAccent | undefined,
  lit: "hover" | "on",
): { style?: React.CSSProperties; className?: string } {
  const when = lit === "on" ? "tpl-veil-on" : "tpl-veil-hover";
  if (accent?.hue !== undefined)
    return {
      style: { "--tpl-hue": accent.hue } as React.CSSProperties,
      className: cn("tpl-veil", when),
    };
  if (accent?.tone) return { className: cn("tpl-veil tpl-veil-neutral", when) };
  return {};
}

/** The plate a logo needs, if any: black-only ink gets one on the dark theme,
 *  white-only ink gets one on the light theme, and the CSS scopes each to its
 *  own theme so the other surface is left alone. */
export function plateClass(accent?: LogoAccent): string | undefined {
  if (accent?.tone === "dark") return "tpl-plate-dark";
  if (accent?.tone === "light") return "tpl-plate-light";
  return undefined;
}
