"use client";

import Link from "@/components/ui/link";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";

export function SettingsShortcut({
  href,
  label,
  className,
}: {
  href: string;
  label: string;
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
