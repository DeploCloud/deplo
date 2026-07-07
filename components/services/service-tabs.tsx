"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useLiveRunning } from "@/components/services/service-live-status";
import {
  useSlidingRect,
  SlidingUnderline,
} from "@/components/ui/sliding-underline";

export function ServiceTabs({
  slug,
  running: serverRunning = false,
  devEligible = false,
  canManageEnv = true,
  showFiles = false,
  canBackup = false,
}: {
  slug: string;
  running?: boolean;
  /** Source-bearing services get a Dev Mode tab (live container + SSH access). */
  devEligible?: boolean;
  /** The Environment tab is only shown to members with the manage_env capability. */
  canManageEnv?: boolean;
  /** The Files tab is shown only when the service has an on-disk files dir and
   *  the viewer holds the manage_files capability (resolved server-side). */
  showFiles?: boolean;
  /** The Backups tab is shown only to members with the manage_infra capability
   *  (backup/restore are infra ops; the page guards server-side too). */
  canBackup?: boolean;
}) {
  const pathname = usePathname();
  const base = `/services/${slug}`;
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
    // live container, so they only appear while the service is running.
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
    // Dev Mode (live editable container + SSH) — only for source-bearing services.
    ...(devEligible
      ? [
          {
            label: "Dev Mode",
            href: `${base}/dev`,
            active: matchSub("/dev"),
          },
        ]
      : []),
    // Files (browse/edit the service's /data/stacks/files/<slug> tree) — only
    // when that dir exists and the viewer holds the manage_files capability.
    ...(showFiles
      ? [
          {
            label: "Files",
            href: `${base}/files`,
            active: matchSub("/files"),
          },
        ]
      : []),
    // Backups (schedule + run + restore the service's volumes/files) — only for
    // members holding manage_infra. The page guards server-side too.
    ...(canBackup
      ? [
          {
            label: "Backups",
            href: `${base}/backups`,
            active: matchSub("/backups"),
          },
        ]
      : []),
    {
      label: "Settings",
      href: `${base}/settings`,
      active: matchSub("/settings"),
    },
  ];

  // Single underline that slides to the active tab (instead of each tab toggling
  // its own static underline). Re-measures when the active tab changes or the tab
  // set changes (Console/Logs/Dev/Files appear and disappear).
  const containerRef = React.useRef<HTMLDivElement>(null);
  const tabRefs = React.useRef(new Map<string, HTMLAnchorElement | null>());
  const activeLabel = tabs.find((t) => t.active)?.label ?? null;
  const signature = tabs.map((t) => t.label).join("|");
  const rect = useSlidingRect(
    containerRef,
    () => (activeLabel ? (tabRefs.current.get(activeLabel) ?? null) : null),
    [activeLabel, signature],
  );

  return (
    <div
      ref={containerRef}
      className="relative flex h-12 items-center gap-1 border-b border-border"
    >
      {tabs.map((t) => (
        <Link
          key={t.label}
          ref={(el) => {
            tabRefs.current.set(t.label, el);
          }}
          href={t.href}
          className={cn(
            "flex h-12 cursor-pointer items-center px-3 text-sm font-medium transition-colors",
            t.active
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
      <SlidingUnderline rect={rect} />
    </div>
  );
}
