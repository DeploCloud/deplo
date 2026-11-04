"use client";

import Link from "@/components/ui/link";
import { SettingsShortcut } from "@/components/shared/settings-shortcut";
import { Bone } from "@/components/ui/skeleton";

export interface PaneTitle {
  label: string;
  href: string;
  settingsHref?: string;
}

export function PaneTitleLink({
  title,
  loading = false,
}: {
  title?: PaneTitle | null;
  loading?: boolean;
}) {
  if (!title) return null;
  return (
    <>
      <Link
        href={title.href}
        title={`Open ${title.label}`}
        className="max-w-60 shrink-0 cursor-pointer truncate text-sm font-medium underline-offset-4 hover:underline"
      >
        <Bone loading={loading}>{title.label}</Bone>
      </Link>
      {title.settingsHref && (
        <SettingsShortcut
          href={title.settingsHref}
          label="Advanced settings"
          className="size-9"
        />
      )}
    </>
  );
}
