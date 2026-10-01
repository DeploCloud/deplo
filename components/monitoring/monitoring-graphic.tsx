import {
  Box,
  Decal,
  IsoArt,
  UNIT,
  fit,
  floor,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [1.5, 3.5, 0] };
const NECK: BoxShape = { at: [0.5, 1.5, 0], size: [0.25, 0.5, 0.4] };
// Facing right: on that face a rising trace climbs on screen too.
const SCREEN: BoxShape = { at: [0.4, 0.25, 0.4], size: [0.35, 3, 2] };
const W = 3 * UNIT;
const H = 2 * UNIT;
const PAD = 9;

// The flat illustration's trace (x 22-92, y 28-60), stretched over the screen.
const TRACE = [
  [22, 60],
  [31, 52],
  [39, 56],
  [48, 40],
  [57, 46],
  [66, 34],
  [74, 38],
  [83, 28],
  [92, 32],
].map(([x, y]) => [
  W * (0.12 + ((x - 22) / 70) * 0.74),
  H * (0.22 + ((y - 28) / 32) * 0.56),
]);
const [LX, LY] = TRACE[TRACE.length - 1];

export function MonitoringGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A chart drawing a line across an empty panel, waiting for the first measurements"
      view={fit([FLOOR, SCREEN])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Box {...NECK} />
      <Box {...SCREEN} />

      <Decal face="right" at={[0.75, 3.25, 2.4]}>
        <rect
          x={PAD - 3}
          y={PAD - 3}
          width={W - 2 * PAD + 6}
          height={H - 2 * PAD + 6}
          fill="var(--iso-floor)"
          stroke="var(--ring)"
          strokeWidth="1.5"
        />
        <g stroke="var(--border)" strokeWidth="1.5">
          <path d={`M${PAD + 4} ${H * 0.36}H${W - PAD - 4}`} />
          <path d={`M${PAD + 4} ${H * 0.66}H${W - PAD - 4}`} />
        </g>
        <polyline
          points={TRACE.map((p) => p.join(",")).join(" ")}
          pathLength={1}
          stroke="var(--chart-1)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ vectorEffect: "none" }}
          className="iso-metrics-trace"
        />
        <circle
          cx={LX}
          cy={LY}
          r="6"
          stroke="var(--chart-1)"
          strokeWidth="1.5"
          className="iso-metrics-halo"
        />
        <circle
          cx={LX}
          cy={LY}
          r="4.5"
          fill="var(--chart-1)"
          className="iso-metrics-live"
        />
      </Decal>
    </IsoArt>
  );
}
