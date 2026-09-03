"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { cn } from "@/lib/utils";
import type { BackupDTO } from "@/lib/data/backups";

/** The app's or the database's own Backups tab, or null when the target is gone. */
export function targetHref(backup: BackupDTO): string | null {
  if (backup.targetKind === "app")
    return backup.serviceSlug ? `/apps/${backup.serviceSlug}/backups` : null;
  return backup.databaseId && backup.databaseName
    ? `/storage/databases/${backup.databaseId}/backups`
    : null;
}

/**
 * What a schedule backs up, wearing its own logo and linking to that app's or
 * database's Backups tab - where its runs and restore points live.
 */
export function BackupTarget({
  backup,
  size = 20,
  linked = true,
  className,
}: {
  backup: BackupDTO;
  size?: number;
  /** False where the whole card is already a link to the same place. */
  linked?: boolean;
  className?: string;
}) {
  const isApp = backup.targetKind === "app";
  const name = isApp ? backup.serviceName : backup.databaseName;
  const href = targetHref(backup);

  const body = (
    <>
      {isApp ? (
        <AppLogo logo={backup.serviceLogo} size={size} />
      ) : (
        <DatabaseLogo
          type={backup.databaseType ?? "postgres"}
          logo={backup.databaseLogo}
          size={size}
        />
      )}
      <span className="min-w-0 truncate">
        {name ?? <span className="italic">deleted</span>}
      </span>
    </>
  );

  const shell = cn("flex min-w-0 items-center gap-2", className);
  if (!href || !linked) return <span className={shell}>{body}</span>;
  return (
    // `data-card-actions` keeps the link clickable above a selectable card's
    // click handler, the same contract the app grid uses.
    <Link
      href={href}
      data-card-actions
      className={cn(shell, "hover:underline")}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {body}
    </Link>
  );
}
