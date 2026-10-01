import {
  Box,
  IsoArt,
  UNIT,
  fit,
  floor,
  pt,
  shade,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const TEAL = "var(--chart-5)";
const FLOOR: BoxShape = { at: [0, 0, 0], size: [4, 2.4, 0] };
const COPY: BoxShape = { at: [0.4, 1, 0], size: [0.4, 0.4, 0.4] };
// The bucket: a frustum standing at (3, 1.2), wider at the rim than at the base.
const RIM = 0.62;
const BASE = 0.44;
const DEPTH = 0.95;
const BAND = 0.62;
const RX = 48 * Math.SQRT2;
const RY = UNIT / Math.SQRT2;

export function DestinationGraphic({ className }: { className?: string }) {
  const [cx, cy] = pt([3, 1.2, 0]);
  const top = cy - DEPTH * UNIT;
  const [rx, ry, bx, by] = [RX * RIM, RY * RIM, RX * BASE, RY * BASE];
  const wall = `M${cx - rx} ${top}L${cx - bx} ${cy}A${bx} ${by} 0 0 0 ${cx + bx} ${cy}L${cx + rx} ${top}A${rx} ${ry} 0 0 1 ${cx - rx} ${top}Z`;
  const bucket = tone(TEAL);
  const band = RX * (BASE + (RIM - BASE) * BAND);
  return (
    <IsoArt
      label="A copy arcing through the air into a storage bucket"
      view={fit([FLOOR, { at: [0, 0, 0], size: [4, 1.2, 2.6] }])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />

      <ellipse
        cx={cx}
        cy={top}
        rx={rx}
        ry={ry}
        fill={shade(TEAL, "right")}
        stroke={TEAL}
        strokeWidth="1.5"
      />

      <g className="iso-s3-throw">
        <g className="iso-s3-arc">
          <Box {...COPY} tone={tone(TEAL)} />
        </g>
      </g>

      <path
        d={wall}
        fill={bucket.left}
        stroke={TEAL}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d={`M${cx - band} ${cy - BAND * DEPTH * UNIT}A${band} ${(band * RY) / RX} 0 0 0 ${cx + band} ${cy - BAND * DEPTH * UNIT}`}
        stroke={TEAL}
        strokeWidth="1.5"
      />
    </IsoArt>
  );
}
