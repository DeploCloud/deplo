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

const FLOOR: BoxShape = { at: [0, 0, 0], size: [3.4, 1.6, 0] };
const PANE: BoxShape = { at: [0.2, 0.5, 0], size: [3, 0.3, 2.1] };
const SCREEN = { u: [0.04, 0.96], v: [0.05, 0.8] } as const;

// Rows top to bottom; the caret rests on the fourth, under the written lines.
const ROWS = [0.66, 0.5, 0.34, 0.18];
const LENGTHS = [0.5, 0.68, 0.38];

export function LogsGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="An empty log pane filling with lines of output, one after another"
      view={fit([FLOOR, PANE])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Box {...PANE}>
        <FaceRect box={PANE} face="left" {...SCREEN} fill="var(--terminal)" />
        <Decal face="left" at={[0.2, 0.8, 2.1]}>
          {[0.14, 0.24, 0.34].map((x) => (
            <circle
              key={x}
              cx={x * UNIT}
              cy={0.1 * 2.1 * UNIT}
              r={0.035 * UNIT}
              className="fill-ring"
              stroke="none"
            />
          ))}
        </Decal>
        {LENGTHS.map((length, i) => (
          <g
            key={i}
            className="iso-logs-line"
            style={{ animationDelay: `${i * 0.4}s` }}
          >
            <FaceRect
              box={PANE}
              face="left"
              u={[0.08, 0.11]}
              v={[ROWS[i] - 0.03, ROWS[i] + 0.03]}
              fill="var(--success)"
            />
            <FaceRect
              box={PANE}
              face="left"
              u={[0.15, 0.15 + length]}
              v={[ROWS[i] - 0.02, ROWS[i] + 0.02]}
              fill="var(--muted-foreground)"
            />
          </g>
        ))}
        <FaceRect
          box={PANE}
          face="left"
          u={[0.08, 0.11]}
          v={[ROWS[3] - 0.04, ROWS[3] + 0.04]}
          fill="var(--success)"
          className="iso-logs-caret"
        />
      </Box>
    </IsoArt>
  );
}
