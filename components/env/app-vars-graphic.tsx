import {
  Box,
  Disc,
  FaceRect,
  IsoArt,
  fit,
  floor,
  tone,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [3, 3, 0] };
const H = 1.1;
// Left to right on screen: the order the variables arrive in.
const APPS: P[] = [
  [0.1, 2.1, 0],
  [1.1, 1.1, 0],
  [2.1, 0.1, 0],
];

export function AppVarsGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="Three app cards, each receiving its own environment variable"
      view={fit([FLOOR, { at: [0, 0, 0], size: [3, 3, H + 1.2] }])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      {APPS.map((at, i) => {
        const card: BoxShape = { at, size: [0.8, 0.8, H] };
        const slab: BoxShape = {
          at: [at[0] + 0.1, at[1] + 0.1, H],
          size: [0.6, 0.6, 0.18],
        };
        return (
          <g key={i}>
            <Box {...card}>
              <FaceRect
                box={card}
                face="left"
                u={[0.15, 0.6]}
                v={[0.78, 0.84]}
                fill="var(--border)"
              />
              <FaceRect
                box={card}
                face="right"
                u={[0.15, 0.6]}
                v={[0.78, 0.84]}
                fill="var(--border)"
              />
            </Box>
            <g
              className="iso-avars-var"
              style={{ animationDelay: `${i * 0.45}s` }}
            >
              <Box {...slab} tone={tone("var(--info)")}>
                <FaceRect
                  box={slab}
                  face="left"
                  u={[0.15, 0.85]}
                  v={[0.35, 0.65]}
                  fill="var(--iso-base)"
                />
              </Box>
              {[0.25, 0.5, 0.75].map((u) => (
                <Disc
                  key={u}
                  at={[slab.at[0] + u * 0.6, slab.at[1] + 0.3, H + 0.18]}
                  r={0.05}
                  fill="var(--iso-base)"
                />
              ))}
            </g>
          </g>
        );
      })}
    </IsoArt>
  );
}
