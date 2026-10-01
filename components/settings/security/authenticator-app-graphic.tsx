import {
  Box,
  Decal,
  IsoArt,
  UNIT,
  fit,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

// A phone lying on its back: the screen is the top face, portrait along y.
const PHONE: BoxShape = { at: [0, 0, 0], size: [1.1, 1.9, 0.14] };
const W = 1.1 * UNIT;
const H = 1.9 * UNIT;

export function AuthenticatorAppGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A phone showing a six-digit code and its countdown"
      view={fit([PHONE], 4)}
      className={cn("size-12", className)}
    >
      <Box {...PHONE}>
        <Decal face="top" at={[0, 0, 0.14]}>
          <circle
            cx={W / 2}
            cy={H * 0.34}
            r={13}
            stroke="var(--ring)"
            strokeWidth="2.5"
          />
          <path
            d={`M${W / 2} ${H * 0.34 - 13}a13 13 0 1 1 -13 13`}
            stroke="var(--chart-1)"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="iso-blink"
          />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect
              key={i}
              x={W * 0.13 + i * W * 0.13}
              y={H * 0.62}
              width={5}
              height={14}
              rx={2.5}
              fill="var(--muted-foreground)"
            />
          ))}
        </Decal>
      </Box>
    </IsoArt>
  );
}
