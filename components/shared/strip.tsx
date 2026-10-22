import { CirclePause } from "lucide-react";
import type { ElementType, ReactNode } from "react";

import Link from "@/components/ui/link";

// A slim strip under the top bar while something instance-wide needs saying.
export function Strip({
  message,
  progressHref,
  linkLabel = "Show progress",
  icon: Icon = CirclePause,
  action,
}: {
  message: string;
  progressHref: string | null;
  linkLabel?: string;
  icon?: ElementType;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/40 bg-warning-wash px-4 py-2 text-sm text-warning sm:px-6 lg:px-8"
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{message}</span>
      {progressHref && (
        <Link
          href={progressHref}
          className="font-medium underline underline-offset-2 hover:no-underline"
        >
          {linkLabel}
        </Link>
      )}
      {action}
    </div>
  );
}
