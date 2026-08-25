"use client";

import Link from "next/link";

/**
 * What a full-screen pane belongs to, and the way back to it. On a full-bleed
 * route that toolbar is the ONLY heading left: the page title and the app header
 * are both gone, and the breadcrumb sits a row up in the shell's own chrome.
 */
export interface PaneTitle {
  label: string;
  /** The App's or database's Overview. */
  href: string;
}

export function PaneTitleLink({ title }: { title?: PaneTitle | null }) {
  if (!title) return null;
  return (
    <Link
      href={title.href}
      title={`Open ${title.label}`}
      className="max-w-60 shrink-0 cursor-pointer truncate text-sm font-medium underline-offset-4 hover:underline"
    >
      {title.label}
    </Link>
  );
}
