"use client";

import Link from "@/components/ui/link";
import { SettingsShortcut } from "@/components/shared/settings-shortcut";

// PaneTitle names what a full-screen pane belongs to, and the way back to it.
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
      {/* h-9, not the h-8 default: a short control reads as a broken row. */}
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
