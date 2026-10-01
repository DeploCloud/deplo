import {
  Box,
  Decal,
  IsoArt,
  UNIT,
  fit,
  floor,
  pt,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [3.6, 2.8, 0] };
const DRUM = { at: [1.9, 1.15] as const, r: 0.8, h: 1.5 };
const RX = 48 * Math.SQRT2 * DRUM.r;
const RY = (UNIT / Math.SQRT2) * DRUM.r;
// The weed rolls along +x in front of the drum, edge to edge of the floor.
const LANE = 2.45;
const R = 0.3;

/** The drum that is not there: a dashed outline, the back of its base hidden like a solid's. */
function Ghost() {
  const [cx, cy] = pt([...DRUM.at, 0]);
  const top = cy - DRUM.h * UNIT;
  const front = (y: number) =>
    `M${cx - RX} ${y}A${RX} ${RY} 0 0 0 ${cx + RX} ${y}`;
  return (
    <g
      className="stroke-muted-foreground"
      strokeWidth="1.5"
      strokeDasharray="4 4"
    >
      <ellipse cx={cx} cy={top} rx={RX} ry={RY} />
      <path d={`M${cx - RX} ${top}V${cy}M${cx + RX} ${top}V${cy}`} />
      <path d={front(cy)} />
      <path d={front(cy - (DRUM.h * UNIT) / 2)} />
    </g>
  );
}

export function DatabaseGraphic({ className }: { className?: string }) {
  const [cx, cy] = pt([0, LANE, R]);
  return (
    <IsoArt
      label="The dashed outline of a database with a tumbleweed bouncing past it"
      view={fit([FLOOR, { at: [1.1, 0.35, 0], size: [1.6, 1.6, 1.6] }])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Ghost />

      <g className="iso-db-roll">
        <g className="iso-db-hop">
          <g transform={`translate(${cx} ${cy})`}>
            <circle r={R * UNIT} stroke="var(--chart-4)" strokeWidth="1.5" />
            <Decal face="left" at={[0, 0, 0]}>
              <g
                className="iso-db-spin"
                stroke="var(--chart-4)"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M-12 -4 L11 5 M-5 -12 L7 11 M-11 6 L12 -2 M2 -12 L-4 12" />
                <circle r="7.5" />
              </g>
            </Decal>
          </g>
        </g>
      </g>
    </IsoArt>
  );
}
