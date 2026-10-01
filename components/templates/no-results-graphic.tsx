import {
  Box,
  Disc,
  IsoArt,
  fit,
  floor,
  ghost,
  pt,
  tone,
  wire,
  type P,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const TEMPLATES = [
  ...[1, 2, 3, 4, 5].map((n) => `var(--chart-${n})`),
  "var(--violet)",
];
const SWEEP_S = 3.6;
const LENS: P = [-0.5, 1, 1.4];
const R = 0.95;

// The lens as it fades in and out: the rest of its sweep overflows the frame.
const lensAt = (x: number) => ({
  at: [x - R, 0.05, LENS[2]] as P,
  size: [2 * R, 2.85, 0] as P,
});

/** The lens's rim: a flat ring on the top plane, `r` steps out from `at`. */
function Rim({ at, r, fill }: { at: P; r: number; fill: string }) {
  const [cx, cy] = pt(at);
  const ring = (k: number) => {
    const rx = 48 * Math.SQRT2 * r * k;
    const ry = ((32 * Math.sqrt(3)) / Math.SQRT2) * r * k;
    return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
  };
  return (
    <path
      d={ring(1) + ring(0.74)}
      fillRule="evenodd"
      fill={fill}
      stroke="var(--info)"
      strokeWidth="1.5"
    />
  );
}

export function NoResultsGraphic({ className }: { className?: string }) {
  const [x, y, z] = LENS;
  return (
    <IsoArt
      label="A magnifying glass sweeping across a row of templates, finding none"
      view={fit([
        { at: [0, 0, 0], size: [3, 2, 0.6] },
        lensAt(0.5),
        lensAt(2.5),
      ])}
      className={cn("size-32", className)}
    >
      <Box at={[0, 0, 0]} size={[3, 2, 0]} tone={floor} />
      {TEMPLATES.map((color, i) => {
        const at: P = [0.2 + (i % 3), 0.2 + Math.floor(i / 3), 0];
        return (
          <g key={color}>
            <Box at={at} size={[0.6, 0.6, 0.6]} tone={ghost} className={wire} />
            <Box
              at={at}
              size={[0.6, 0.6, 0.6]}
              tone={tone(color)}
              className="iso-noresults-item"
              style={{
                animationDelay: `${((i % 3) * SWEEP_S) / 4 - SWEEP_S}s`,
              }}
            />
          </g>
        );
      })}

      <g className="iso-noresults-lens">
        <Disc
          at={[x, y, z - 0.1]}
          r={R}
          fill="none"
          stroke="var(--info)"
          strokeWidth="1.5"
        />
        <Rim at={[x, y, z]} r={R} fill="var(--info)" />
        <Box
          at={[x - 0.1, y + R, z - 0.12]}
          size={[0.2, 0.9, 0.14]}
          tone={tone("var(--info)")}
        />
      </g>
    </IsoArt>
  );
}
