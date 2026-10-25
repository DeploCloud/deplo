import { ShieldAlert, X } from "lucide-react";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/utils";

// The Overview's one-click answer to "what needs a security fix today?".
export function SecurityFilterChip({
  active,
  count,
  view,
}: {
  active: boolean;
  count: number;
  view: "grid" | "list";
}) {
  if (!active && count === 0) return null;
  const listed = view === "list" ? "view=list" : "";
  const href = active
    ? listed
      ? `/?${listed}`
      : "/"
    : `/?needs=security${listed ? `&${listed}` : ""}`;
  return (
    <Button asChild size="sm" variant={active ? "secondary" : "outline"}>
      <Link href={href}>
        <ShieldAlert className="size-4 text-warning" />
        {active
          ? "Needs security update"
          : `Needs security update (${plural(count, "app", "apps")})`}
        {active && <X className="size-3.5" />}
      </Link>
    </Button>
  );
}
