"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { SettingsShortcut } from "@/components/shared/settings-shortcut";

/**
 * What a full-screen pane belongs to, and the way back to it. On a full-bleed
 * route that toolbar is the ONLY heading left: the page title and the app header
 * are both gone, and the breadcrumb sits a row up in the shell's own chrome.
 */
export interface PaneTitle {
  label: string;
  /** The App's or database's Overview. */
  href: string;
  /** Advanced settings, when the pane has a settings page behind it - the gear
   *  beside the label. The log panes have none and pass nothing. */
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
      {/* h-9, not the h-8 default: everything beside the Select in the console
          toolbar is h-9, and a short control reads as a broken row. */}
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
