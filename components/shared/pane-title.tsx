"use client";

import Link from "@/components/ui/link";
import { SettingsShortcut } from "@/components/shared/settings-shortcut";

export interface PaneTitle {
  label: string;
  href: string;
  settingsHref?: string;
}

export function PaneTitleLink({ title }: { title?: PaneTitle | null }) {
  if (!title) return null;
  return (
    <>
      <Link
        href={title.href}
        title={`Open ${title.label}`}
        className="max-w-60 shrink-0 cursor-pointer truncate text-sm font-medium underline-offset-4 hover:underline"
      >
        {title.label}
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
