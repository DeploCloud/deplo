"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function ProjectTabs({
  slug,
  running = false,
}: {
  slug: string;
  running?: boolean;
}) {
  const pathname = usePathname();
  const base = `/projects/${slug}`;

  // The Deployments tab is an anchor on the Overview page, so the active state
  // must also consider the URL hash to tell the two apart.
  const [hash, setHash] = React.useState("");
  React.useEffect(() => {
    const update = () => setHash(window.location.hash);
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, [pathname]);

  const onBase = pathname === base;
  const onDeployments = onBase && hash === "#deployments";
  // Deployment detail pages live under the project; keep a parent tab active.
  const onDeploymentDetail = pathname.startsWith(base + "/deployments/");

  function matchSub(seg: string) {
    const p = base + seg;
    return pathname === p || pathname.startsWith(p + "/");
  }

  const tabs = [
    {
      label: "Overview",
      href: base,
      active: (onBase && !onDeployments) || onDeploymentDetail,
      onClick: () => setHash(""),
    },
    {
      label: "Deployments",
      href: `${base}#deployments`,
      active: onDeployments,
      onClick: () => setHash("#deployments"),
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
          onClick={t.onClick}
          className={cn(
            "relative flex h-12 cursor-pointer items-center px-3 -mb-px text-sm font-medium transition-colors after:absolute after:bottom-0 after:left-0 after:h-0.5 after:w-full",
            t.active
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
