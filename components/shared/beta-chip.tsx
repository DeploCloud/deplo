import { Badge } from "@/components/ui/badge";

/**
 * The one spelling of "this is beta", so a feature carrying it looks the same
 * everywhere it appears. Matches the chip the Git providers already use.
 *
 * It is a promise about SUPPORT, not a warning label: the thing works, it has
 * simply not been through as many real fleets as the rest of the product yet.
 */
export function BetaChip() {
  return (
    <Badge variant="info" className="text-[10px] font-normal uppercase">
      Beta
    </Badge>
  );
}
