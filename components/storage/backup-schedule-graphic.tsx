import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  UNIT,
  fit,
  floor,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [3.2, 3.2, 0] };
const ARCHIVE: BoxShape = { at: [1.05, 1.05, 0], size: [1.1, 1.1, 0.75] };
const R = 1.35 * UNIT;
// 300 degrees clockwise on the floor, the gap and the head on the open left side.
const at = (deg: number, r = R): [number, number] => [
  r * Math.sin((deg * Math.PI) / 180),
  -r * Math.cos((deg * Math.PI) / 180),
];
const START = at(255);
const END = at(195);
const HEAD = [at(180, R + 9), END, at(180, R - 9)]
  .map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`)
  .join(" L");
// Painted on the floor, so the stroke foreshortens with it.
const PAINT = { vectorEffect: "none", strokeWidth: 6 } as const;

export function BackupScheduleGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="An arrow looping round an archive, closing and starting again"
      view={fit([FLOOR, ARCHIVE])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Decal face="top" at={[1.6, 1.6, 0]}>
        <path
          d={`M${START[0]} ${START[1]} A${R} ${R} 0 1 1 ${END[0]} ${END[1]}`}
          pathLength="1"
          stroke="var(--chart-1)"
          strokeLinecap="round"
          className="iso-bk-loop"
          style={PAINT}
        />
        <path
          d={`M${HEAD}`}
          stroke="var(--chart-1)"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="iso-bk-arrow"
          style={PAINT}
        />
      </Decal>
      <Box {...ARCHIVE}>
        <FaceRect
          box={ARCHIVE}
          face="left"
          u={[0, 1]}
          v={[0.7, 0.73]}
          fill="var(--ring)"
        />
        <FaceRect
          box={ARCHIVE}
          face="right"
          u={[0, 1]}
          v={[0.7, 0.73]}
          fill="var(--ring)"
        />
        <FaceRect
          box={ARCHIVE}
          face="left"
          u={[0.35, 0.65]}
          v={[0.32, 0.46]}
          fill="var(--border)"
        />
      </Box>
    </IsoArt>
  );
}
