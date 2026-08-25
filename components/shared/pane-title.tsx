"use client";

import Link from "next/link";

/**
 * What the pane's logs belong to, and the way back to it.
 *
 * On the full-screen route the toolbar is the ONLY heading left: the page title
 * and the app header are both gone, and the breadcrumb sits a row up in the
 * shell's own chrome. So the name is said here — and since dropping the header
 * also dropped the way back to the app, it is the link too. Somebody who came in
 * on a link, or back to a tab left open beside three others, can read what they
 * are looking at and leave it without hunting for the breadcrumb.
 */
export interface LogTitle {
  label: string;
  /** The App's or database's Overview. */
  href: string;
}

export function LogTitleLink({ title }: { title?: LogTitle | null }) {
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
