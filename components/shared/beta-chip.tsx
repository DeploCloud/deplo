import { Badge } from "@/components/ui/badge";

// BetaChip - the one spelling of "this is beta", so it looks the same everywhere.
export function BetaChip() {
  return (
    <Badge variant="info" className="text-[10px] font-normal uppercase">
      Beta
    </Badge>
  );
}
