"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function ProjectTabs({
  slug,
  running = false,
  devEligible = false,
}: {
  slug: string;
  running?: boolean;
  /** Source-bearing projects get a Dev Mode tab (live container + SSH access). */
  devEligible?: boolean;
}) {
  const pathname = usePathname();
  const base = `/projects/${slug}`;

  function matchSub(seg: string) {
    const p = base + seg;
    return pathname === p || pathname.startsWith(p + "/");
  }

  const tabs = [
    { label: "Overview", href: base, active: pathname === base },
    {
      // Deployment detail pages live under here, so keep the tab active for them.
      label: "Deployments",
      href: `${base}/deployments`,
      active: matchSub("/deployments"),
    },
    {
      label: "Environment",
      href: `${base}/environment`,
      active: matchSub("/environment"),
    },
    {
      label: "Domains",
      href: `${base}/domains`,
      active: matchSub("/domains"),
    },
    // Container console (docker attach) is only meaningful while running.
    ...(running
      ? [
          {
            label: "Console",
            href: `${base}/console`,
            active: matchSub("/console"),
          },
        ]
      : []),
    // Dev Mode (live editable container + SSH) — only for source-bearing projects.
    ...(devEligible
      ? [
          {
            label: "Dev Mode",
            href: `${base}/dev`,
            active: matchSub("/dev"),
          },
        ]
      : []),
    {
      label: "Settings",
      href: `${base}/settings`,
      active: matchSub("/settings"),
    },
  ];

  return (
    <div className="flex h-12 items-center gap-1 border-b border-border">
      {tabs.map((t) => (
        <Link
          key={t.label}
          href={t.href}
          className={cn(
            "relative flex h-12 cursor-pointer items-center px-3 -mb-px text-sm font-medium transition-colors after:absolute after:bottom-0 after:left-0 after:h-0.5 after:w-full",
            t.active
              ? "text-foreground after:bg-foreground"
              : "text-muted-foreground hover:text-foreground after:bg-transparent",
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
