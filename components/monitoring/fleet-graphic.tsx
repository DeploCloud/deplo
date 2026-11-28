import {
  Box,
  IsoArt,
  Ring,
  beat,
  fit,
  floor,
  type BoxShape,
} from "@/components/iso/iso";
import { Rack } from "@/components/iso/parts";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [5.6, 1.8, 0] };
const RACKS: BoxShape[] = [
  { at: [0.3, 0.3, 0], size: [1.3, 1.2, 2] },
  { at: [2.15, 0.3, 0], size: [1.3, 1.2, 3] },
  { at: [4, 0.3, 0], size: [1.3, 1.2, 2] },
];

export function FleetGraphic({
  attention = false,
  className,
}: {
  attention?: boolean;
  className?: string;
}) {
  const marked = attention ? RACKS[2] : RACKS[1];
  return (
    <IsoArt
      label={
        attention
          ? "A row of servers, one of them blinking amber"
          : "A row of servers, every light green"
      }
      view={fit([FLOOR, ...RACKS])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      {RACKS.map((box, r) => (
        <Rack
          key={r}
          box={box}
          led={(i) => ({
            fill:
              attention && r === 2 && i === 0
                ? "var(--warning)"
                : "var(--success)",
            className: "iso-blink",
            style: beat(r * 3 + i + 1),
          })}
        />
      ))}
      <Ring
        at={[marked.at[0], marked.at[1], marked.size[2]]}
        size={marked.size}
        color={attention ? "var(--warning)" : "var(--success)"}
      />
    </IsoArt>
  );
}
