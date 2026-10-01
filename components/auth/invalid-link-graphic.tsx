import {
  Box,
  Decal,
  IsoArt,
  Path,
  UNIT,
  fit,
  floor,
  type BoxShape,
  type Face,
  type P,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [4.2, 1.6, 0] };
const GAP: P = [2.07, 0.8, 0.42];
const LONG = 1.5 * UNIT;
const SHORT = 0.8 * UNIT;
const BAR = 11;
const DEPTH = 0.14;

const stadium = (x: number, y: number, w: number, h: number) => {
  const r = h / 2;
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
};
// The break throws sparks along the axes: up, down, and across the chain.
const RAYS: P[] = [
  [0, 0, 1],
  [0, 0, -1],
  [0, 1, 0],
  [0, -1, 0],
];

const RING =
  stadium(0, 0, LONG, SHORT) +
  stadium(BAR, BAR, LONG - 2 * BAR, SHORT - 2 * BAR);

/** One link, a rounded ring with some thickness behind it (`back` is that offset). */
function Link({ face, at, back }: { face: Face; at: P; back: P }) {
  const ring = (fill: string) => (
    <path
      d={RING}
      fillRule="evenodd"
      fill={fill}
      stroke="var(--muted-foreground)"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  );
  return (
    <>
      <Decal face={face} at={back}>
        {ring("var(--iso-right)")}
      </Decal>
      <Decal face={face} at={at}>
        {ring("var(--iso-top)")}
      </Decal>
    </>
  );
}

// A chain alternates planes: the left link stands up, the right one lies flat.
export function InvalidLinkGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A chain link that has come apart"
      view={fit([FLOOR, { at: [0, 0, 0], size: [4.2, 1.6, 0.8] }])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <g className="iso-unlink-track">
        <Path
          points={[
            [0.05, 0.8, 0],
            [0.4, 0.8, 0],
          ]}
          stroke="var(--ring)"
          strokeWidth="2"
          strokeDasharray="2 6"
        />
        <Path
          points={[
            [3.8, 0.8, 0],
            [4.15, 0.8, 0],
          ]}
          stroke="var(--ring)"
          strokeWidth="2"
          strokeDasharray="2 6"
        />
      </g>

      <g className="iso-unlink-a">
        <Link
          face="left"
          at={[0.4, 0.8 + DEPTH / 2, 0.8]}
          back={[0.4, 0.8 - DEPTH / 2, 0.8]}
        />
      </g>
      <g className="iso-unlink-b">
        <Link face="top" at={[2.25, 0.4, DEPTH]} back={[2.25, 0.4, 0]} />
      </g>

      <g
        className="iso-unlink-spark"
        stroke="var(--destructive)"
        strokeWidth="2"
      >
        {RAYS.map(([dx, dy, dz], i) => (
          <Path
            key={i}
            points={[
              [GAP[0] + dx * 0.14, GAP[1] + dy * 0.14, GAP[2] + dz * 0.14],
              [GAP[0] + dx * 0.34, GAP[1] + dy * 0.34, GAP[2] + dz * 0.34],
            ]}
          />
        ))}
      </g>
    </IsoArt>
  );
}
