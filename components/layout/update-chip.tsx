"use client";

import { Sparkles } from "lucide-react";

import Link from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useUpstreamUpdate } from "./update-state";

/**
 * The update notice as a header chip: nothing moves, nothing to dismiss, and it
 * sits where the other instance-wide chips already live.
 */
export function UpdateChip() {
  const update = useUpstreamUpdate();
  if (!update) return null;
  const label = `Deplo ${update.latest} is available`;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <Badge variant="success" asChild className="h-7 gap-1.5">
          <Link href="/settings/deplo?tab=updates" aria-label={label}>
            <Sparkles className="size-3.5" />
            <span className="hidden sm:inline">{update.latest}</span>
          </Link>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} - you have v{update.current}
      </TooltipContent>
    </Tooltip>
  );
}
