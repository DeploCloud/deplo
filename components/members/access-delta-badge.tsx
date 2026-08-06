import { ShieldMinus, ShieldPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";

/**
 * "This person is not their role" — the one thing a roster of role names can't
 * say on its own.
 *
 * Two states and no third: something was taken away from them, or something was
 * added. Nothing renders for everyone who simply follows their role, which is
 * almost everybody, so the chip means "look here" rather than decorating every
 * tile. Coloured, because it is the only cell on the page whose whole job is to
 * be noticed: amber for less (the one an admin auditing access needs to see),
 * blue for more.
 *
 * Same component on the tile and on the member's own page — one wording, one
 * colour, and no way for the two surfaces to describe the same person
 * differently.
 */
export function AccessDeltaBadge({
  delta,
  roleName,
  className,
}: {
  delta: "less" | "more" | null;
  /** Named in the tooltip, so "than what" is answered without opening anything. */
  roleName: string | null;
  className?: string;
}) {
  if (!delta) return null;
  const less = delta === "less";
  const Icon = less ? ShieldMinus : ShieldPlus;
  const role = roleName ?? "their role";
  return (
    <SimpleTooltip
      content={
        less
          ? `Someone took access away from them: they can do less than ${role} allows.`
          : `Someone gave them extra access: they can do more than ${role} allows.`
      }
    >
      <Badge variant={less ? "warning" : "info"} className={className}>
        <Icon className="size-3" aria-hidden />
        {less ? "Less than role" : "More than role"}
      </Badge>
    </SimpleTooltip>
  );
}
