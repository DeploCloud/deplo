import {
  Box,
  FaceRect,
  IsoArt,
  Legs,
  fit,
  floor,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [3, 2.6, 0] };
const SHELF: BoxShape = { at: [0.3, 0.3, 0.7], size: [2.4, 2, 0.12] };

// Bottom of the pile first, each a deeper mix of the same colour.
const COPIES = [55, 75, 100].map((mix, i) => ({
  box: { at: [0.7, 0.7, 0.82 + i * 0.34], size: [1.6, 1.2, 0.34] } as BoxShape,
  color:
    mix === 100
      ? "var(--chart-3)"
      : `color-mix(in srgb, var(--chart-3) ${mix}%, var(--iso-base))`,
}));

export function BackupGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="Copies landing one after another on a shelf, building a stack"
      view={fit([FLOOR, { at: [0.7, 0.7, 0.82], size: [1.6, 1.2, 2.5] }])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Legs at={SHELF.at} size={SHELF.size} drop={0.7} />
      <Box {...SHELF} />
      {COPIES.map(({ box, color }, i) => (
        <Box
          key={i}
          {...box}
          tone={tone(color)}
          className="iso-backup-copy"
          style={{ animationDelay: `${i * 0.3}s` }}
        >
          <FaceRect
            box={box}
            face="left"
            u={[0.08, 0.42]}
            v={[0.3, 0.7]}
            fill="var(--iso-top)"
          />
        </Box>
      ))}
    </IsoArt>
  );
}
