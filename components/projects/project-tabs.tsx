"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useLiveRunning } from "@/components/projects/project-live-status";

export function ProjectTabs({
  slug,
  running: serverRunning = false,
  devEligible = false,
  canManageEnv = true,
}: {
  slug: string;
  running?: boolean;
  /** Source-bearing projects get a Dev Mode tab (live container + SSH access). */
  devEligible?: boolean;
  /** The Environment tab is only shown to members with the manage_env capability. */
  canManageEnv?: boolean;
}) {
  const pathname = usePathname();
  const base = `/projects/${slug}`;
  // Live running state drives the Console/Logs tabs so they appear/disappear
  // the moment the container starts/stops — no reload — and stay in sync across
  // clients. Falls back to the server-rendered value before the subscription
  // delivers its first snapshot.
  const running = useLiveRunning(serverRunning);

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
    // Environment is hidden from members without the manage_env capability —
    // env values are sensitive (the page guards server-side too).
    ...(canManageEnv
      ? [
          {
            label: "Environment",
            href: `${base}/environment`,
            active: matchSub("/environment"),
          },
        ]
      : []),
    {
      label: "Domains",
      href: `${base}/domains`,
      active: matchSub("/domains"),
    },
    // Console (docker exec/attach) and Logs (docker logs -f) both stream from a
    // live container, so they only appear while the project is running.
    ...(running
      ? [
          {
            label: "Console",
            href: `${base}/console`,
            active: matchSub("/console"),
          },
          {
            label: "Logs",
            href: `${base}/logs`,
            active: matchSub("/logs"),
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
