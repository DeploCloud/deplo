"use client";

import Link from "next/link";

/**
 * What a full-screen pane belongs to, and the way back to it. Worn by the logs
 * toolbar and the console toolbar alike.
 *
 * On a full-bleed route that toolbar is the ONLY heading left: the page title
 * and the app header are both gone, and the breadcrumb sits a row up in the
 * shell's own chrome. So the name is said here — and since dropping the header
 * also dropped the way back to the app, it is the link too. Somebody who came in
 * on a link, or back to a tab left open beside three others, can read what they
 * are looking at and leave it without hunting for the breadcrumb.
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
