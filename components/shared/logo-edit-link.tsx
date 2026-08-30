// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Pencil } from "lucide-react";

/**
 * A detail header's logo, doubling as the way into General settings: hovering
 * (or focusing) it reveals a pencil over the mark.
 */
export function LogoEditLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="group relative inline-flex shrink-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <span className="absolute inset-0 flex items-center justify-center rounded-md bg-background/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        <Pencil className="size-4 text-foreground" />
      </span>
    </Link>
  );
}
