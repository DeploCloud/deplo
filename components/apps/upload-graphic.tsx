import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  Ring,
  UNIT,
  fit,
  floor,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [-0.3, -0.3, 0], size: [3, 2.6, 0] };
const TRAY: BoxShape = { at: [0, 0, 0], size: [2.4, 2, 0.12] };
const WALL = 0.5;
const ARCHIVE: BoxShape = { at: [0.7, 0.55, 1.4], size: [1, 0.9, 1.2] };
const AMBER = "var(--warning)";

// The hover and drag-over cue the drop zone gives: the archive settles into the tray.
const drop =
  "transition-[translate] duration-300 ease-out group-hover:translate-y-[58.2px] group-data-[active]:translate-y-[58.2px] motion-reduce:transition-none";

export function UploadGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="An archive dropping into an open tray"
      view={fit([FLOOR, ARCHIVE])}
      className={cn("size-28", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Box at={[0, 0, 0]} size={[0.12, 2, WALL]} />
      <Box at={[0, 0, 0]} size={[2.4, 0.12, WALL]} />
      <Box {...TRAY} />
      <Ring
        at={[0.7, 0.55, 0.12]}
        size={[1, 0.9, 0]}
        color="var(--muted-foreground)"
        className="[stroke-dasharray:4_4]"
      />

      <g className={drop}>
        <Box {...ARCHIVE} tone={tone(AMBER)}>
          {[0.82, 0.58, 0.34].map((v) => (
            <FaceRect
              key={v}
              box={ARCHIVE}
              face="left"
              u={[0.46, 0.54]}
              v={[v, v + 0.13]}
              fill={AMBER}
            />
          ))}
          <FaceRect
            box={ARCHIVE}
            face="left"
            u={[0.38, 0.62]}
            v={[0.08, 0.24]}
            fill="var(--iso-top)"
            stroke={AMBER}
          />
        </Box>
      </g>

      <Box at={[0, 1.88, 0]} size={[2.4, 0.12, WALL]}>
        <Decal face="left" at={[0.95, 2, WALL]}>
          <path
            d={`M${0.1 * UNIT} ${0.12 * UNIT}l${0.15 * UNIT} ${0.15 * UNIT}l${0.15 * UNIT} ${-0.15 * UNIT}`}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-ring transition-[stroke,translate] duration-300 ease-out group-hover:translate-y-1 group-hover:stroke-[var(--warning)] group-data-[active]:translate-y-1 group-data-[active]:stroke-[var(--warning)] motion-reduce:transition-none"
          />
        </Decal>
      </Box>
      <Box at={[2.28, 0, 0]} size={[0.12, 2, WALL]} />
    </IsoArt>
  );
}
