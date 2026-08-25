import { Badge } from "@/components/ui/badge";

/**
 * The one spelling of "this is beta", so a feature carrying it looks the same
 * everywhere it appears.
 */
export function BetaChip() {
  return (
    <Badge variant="info" className="text-[10px] font-normal uppercase">
      Beta
    </Badge>
  );
}
