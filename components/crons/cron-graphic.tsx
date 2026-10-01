import {
  Box,
  Decal,
  IsoArt,
  UNIT,
  fit,
  floor,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [-0.5, -0.5, 0], size: [3, 2, 0] };
const CLOCK: BoxShape = { at: [0, 0, 0], size: [2, 1, 2] };
const JOB: BoxShape = { at: [0.75, 0.25, 2], size: [0.5, 0.5, 0.5] };
const R = 0.78 * UNIT;
const TOP = UNIT - R + 9;

export function CronGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A clock hand sweeping round a dial, firing a job each time it passes the top mark"
      view={fit([FLOOR, CLOCK, { ...JOB, at: [0.75, 0.25, 3] }])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Box {...CLOCK} />
      <g className="iso-cron-job">
        <Box {...JOB} tone={tone("var(--success)")} />
      </g>

      <Decal face="left" at={[0, 1, 2]}>
        <circle
          cx={UNIT}
          cy={UNIT}
          r={R}
          fill="var(--iso-top)"
          stroke="var(--ring)"
          strokeWidth="1.5"
        />
        <g stroke="var(--ring)" strokeWidth="1.5" strokeLinecap="round">
          <path d={`M${UNIT + R - 4} ${UNIT}h-7`} />
          <path d={`M${UNIT} ${UNIT + R - 4}v-7`} />
          <path d={`M${UNIT - R + 4} ${UNIT}h7`} />
        </g>
        <circle
          cx={UNIT}
          cy={TOP}
          r="6"
          stroke="var(--success)"
          strokeWidth="1.5"
          className="iso-cron-pulse"
        />
        <g transform={`translate(${UNIT} ${UNIT})`}>
          <path
            d={`M0 0V${-(UNIT - TOP) + 9}`}
            stroke="var(--muted-foreground)"
            strokeWidth="2"
            strokeLinecap="round"
            className="iso-cron-hand"
          />
        </g>
        <circle cx={UNIT} cy={UNIT} r="3" fill="var(--muted-foreground)" />
        <circle
          cx={UNIT}
          cy={TOP}
          r="4"
          fill="var(--success)"
          className="iso-cron-fire"
        />
      </Decal>
    </IsoArt>
  );
}
