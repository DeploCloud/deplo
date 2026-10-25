import { ShieldAlert } from "lucide-react";

import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn, plural } from "@/lib/utils";

// The card's hint that something it runs has a security fix waiting.
export function SecurityShield({
  count,
  exploited,
}: {
  count: number;
  exploited: number;
}) {
  if (count === 0) return null;
  const text =
    plural(count, "security update", "security updates") +
    (exploited ? `, ${exploited} already used in attacks` : "");
  return (
    <SimpleTooltip content={text}>
      <span className="inline-flex items-center" aria-label={text} role="img">
        <ShieldAlert
          className={cn(
            "size-3.5",
            exploited ? "text-destructive" : "text-warning",
          )}
        />
      </span>
    </SimpleTooltip>
  );
}
