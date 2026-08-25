"use client";

import Link from "next/link";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";

/**
 * The gear that opens the settings page for the section on screen — the way from
 * what you are reading to what configures it.
 */
export function SettingsShortcut({
  href,
  label,
  className,
}: {
  href: string;
  label: string;
  /** Only for rows shorter than a button (the connection card's label line). */
  className?: string;
}) {
  return (
    <SimpleTooltip content={label}>
      <Button variant="ghost" size="icon-sm" asChild className={className}>
        <Link href={href} aria-label={label}>
          <Settings className="size-4" />
        </Link>
      </Button>
    </SimpleTooltip>
  );
}
