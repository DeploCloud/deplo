// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Package } from "lucide-react";
import { LogoImage } from "@/components/shared/project-logo";
import { cn } from "@/lib/utils";
import { plateClass, veilProps } from "@/components/templates/veil";
import type { LogoAccent } from "@/lib/templates/logo-color";
import { defaultVariant, type CatalogTemplate } from "@/templates/types";

/**
 * What the browser needs to draw a template, and nothing else. The store is a
 * client component, so an untrimmed catalogue crosses the RSC boundary 388 times
 * over: 368 KB against 103 KB measured. The rest is fetched by the slug page.
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
 * One template in the store. The whole card is the link - deploying is a decision
 * made on the template's own page. `accent` is what its logo's pixels said; a
 * logo that said neither hue nor theme renders plain.
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
