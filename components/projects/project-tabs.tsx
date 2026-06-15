"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function ProjectTabs({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/projects/${slug}`;
  const tabs = [
    { label: "Overview", href: base },
    { label: "Deployments", href: `${base}#deployments` },
    { label: "Environment", href: `${base}/environment` },
    { label: "Domains", href: `${base}/domains` },
    { label: "Settings", href: `${base}/settings` },
  ];

  function active(href: string) {
    const clean = href.split("#")[0];
    if (clean === base) return pathname === base;
    return pathname === clean || pathname.startsWith(clean + "/");
  }

  return (
    <div className="flex h-12 items-center gap-1 border-b border-border">
      {tabs.map((t) => (
        <Link
          key={t.label}
          href={t.href}
          className={cn(
            "relative flex h-12 cursor-pointer items-center px-3 -mb-px text-sm font-medium transition-colors after:absolute after:bottom-0 after:left-0 after:h-0.5 after:w-full",
            active(t.href)
              ? "text-foreground after:bg-foreground"
              : "text-muted-foreground hover:text-foreground after:bg-transparent"
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
