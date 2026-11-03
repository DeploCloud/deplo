"use client";

import { ShieldAlert, Sparkles } from "lucide-react";

import Link from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useUpstreamUpdate } from "./update-state";

export function UpdateChip() {
  const update = useUpstreamUpdate();
  if (!update) return null;
  const fix = update.securityFix;
  const label = fix
    ? `Deplo ${fix} fixes a security flaw`
    : `Deplo ${update.next} is available`;
  const Icon = fix ? ShieldAlert : Sparkles;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <Badge
          variant={fix ? "destructive" : "success"}
          asChild
          className="h-7 gap-1.5"
        >
          <Link href="/settings/deplo?tab=updates" aria-label={label}>
            <Icon className="size-3.5" />
            <span className="hidden sm:inline">
              {fix ? "Security fix" : update.next}
            </span>
          </Link>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} - you have v{update.current}
      </TooltipContent>
    </Tooltip>
  );
}
