import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  UNIT,
  fit,
  floor,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [-0.3, -0.3, 0], size: [3, 1.5, 0] };
const BADGE: BoxShape = { at: [0, 0, 0], size: [2, 0.2, 2.6] };
const CLIP: BoxShape = { at: [0.7, 0.03, 2.6], size: [0.6, 0.14, 0.22] };
const LOCK: BoxShape = { at: [1.5, 0.4, 0], size: [0.9, 0.6, 0.75] };
const SHACKLE = 0.7 * UNIT;

export function AccountGraphic({ className }: { className?: string }) {
  const [lx, ly, lz] = LOCK.at;
  const w = LOCK.size[0] * UNIT;
  return (
    <IsoArt
      label="An identity badge closed by a padlock"
      view={fit([FLOOR, BADGE, CLIP, LOCK], 8)}
      className={cn("size-24", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Box {...CLIP} />
      <Box {...BADGE}>
        <Decal face="left" at={[0, 0.2, 2.6]} style={{ stroke: "none" }}>
          <circle
            cx={UNIT}
            cy={0.8 * UNIT}
            r={0.42 * UNIT}
            fill="var(--chart-1)"
          />
          <circle
            cx={UNIT}
            cy={0.72 * UNIT}
            r={0.13 * UNIT}
            fill="var(--iso-left)"
          />
          <path
            d={`M${0.73 * UNIT} ${1.08 * UNIT}a${0.27 * UNIT} ${0.24 * UNIT} 0 0 1 ${0.54 * UNIT} 0Z`}
            fill="var(--iso-left)"
          />
        </Decal>
        <FaceRect
          box={BADGE}
          face="left"
          u={[0.2, 0.72]}
          v={[0.44, 0.48]}
          fill="var(--ring)"
        />
        <FaceRect
          box={BADGE}
          face="left"
          u={[0.28, 0.6]}
          v={[0.34, 0.38]}
          fill="var(--ring)"
        />
      </Box>

      <Box {...LOCK} tone={tone("var(--success)")}>
        <Decal
          face="left"
          at={[lx, ly + LOCK.size[1], lz + LOCK.size[2]]}
          style={{ stroke: "none" }}
        >
          <circle
            cx={w / 2}
            cy={0.3 * UNIT}
            r={0.08 * UNIT}
            fill="var(--success)"
          />
          <rect
            x={w / 2 - 0.035 * UNIT}
            y={0.3 * UNIT}
            width={0.07 * UNIT}
            height={0.2 * UNIT}
            fill="var(--success)"
          />
        </Decal>
      </Box>
      <Decal face="left" at={[lx, ly + LOCK.size[1] / 2, lz + LOCK.size[2]]}>
        <path
          d={`M${w * 0.22} 0V${-SHACKLE + w * 0.28}a${w * 0.28} ${w * 0.28} 0 0 1 ${w * 0.56} 0V0`}
          stroke="var(--success)"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </Decal>
    </IsoArt>
  );
}
