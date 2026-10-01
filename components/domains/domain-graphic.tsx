import {
  Box,
  Cylinder,
  IsoArt,
  Path,
  fit,
  floor,
  pt,
  shade,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [3, 3, 0] };
const R = 1;
const C: P = [1.5, 1.5, 0.25 + 0.9 * R];
const OCEAN = "var(--info)";
const PIN = "var(--violet)";

const add = (a: P, b: P, k = 1): P => [
  a[0] + b[0] * k,
  a[1] + b[1] * k,
  a[2] + b[2] * k,
];
const facing = (n: P) => n[0] + n[1] + n[2] > 0;

/** The runs of a circle on the globe (`at(s)` gives the unit normal) that face the viewer. */
function visible(at: (s: number) => P, steps = 96): P[][] {
  const runs: P[][] = [];
  let run: P[] = [];
  for (let i = 0; i <= steps; i++) {
    const n = at((i / steps) * 2 * Math.PI);
    if (facing(n)) run.push(add(C, n, R));
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const parallel =
  (lat: number) =>
  (s: number): P => [
    Math.cos(rad(lat)) * Math.cos(s),
    Math.cos(rad(lat)) * Math.sin(s),
    Math.sin(rad(lat)),
  ];
const meridian =
  (lon: number) =>
  (s: number): P => [
    Math.cos(s) * Math.cos(rad(lon)),
    Math.cos(s) * Math.sin(rad(lon)),
    Math.sin(s),
  ];
const GRID = [
  parallel(0),
  parallel(38),
  parallel(-38),
  meridian(15),
  meridian(75),
].flatMap((f) => visible(f));

// The pin goes in up-left of centre, where it stands clear of the globe's face.
const LAT = rad(50);
const LON = rad(100);
const N: P = [
  Math.cos(LAT) * Math.cos(LON),
  Math.cos(LAT) * Math.sin(LON),
  Math.sin(LAT),
];
const SPOT = add(C, N, R);
const HEAD = add(C, N, R + 0.75);

/** The tangent plane at the pin, as a matrix that maps a unit circle onto it. */
function tangent(radius: number) {
  const lin = (v: P) => {
    const [x0, y0] = pt([0, 0, 0]);
    const [x, y] = pt(v);
    return [(x - x0) * radius, (y - y0) * radius];
  };
  const [a, b] = lin([-Math.sin(LON), Math.cos(LON), 0]);
  const [c, d] = lin([
    -Math.sin(LAT) * Math.cos(LON),
    -Math.sin(LAT) * Math.sin(LON),
    Math.cos(LAT),
  ]);
  const [e, f] = pt(SPOT);
  return `matrix(${[a, b, c, d, e, f].map((n) => n.toFixed(2)).join(" ")})`;
}

export function DomainGraphic({ className }: { className?: string }) {
  const [cx, cy] = pt(C);
  const [hx, hy] = pt(HEAD);
  return (
    <IsoArt
      label="A pin landing on a globe, with a signal rippling out from it"
      view={fit([
        FLOOR,
        { at: add(C, [-R, -R, -R]), size: [2 * R, 2 * R, 2 * R] },
        { at: HEAD, size: [0, 0, 0] },
      ])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Cylinder at={[1.5, 1.5, 0]} r={0.5} h={0.25} />

      <circle
        cx={cx}
        cy={cy}
        r={48 * Math.SQRT2 * R}
        fill={shade(OCEAN, "right")}
        stroke={OCEAN}
        strokeWidth="1.5"
      />
      {GRID.map((run, i) => (
        <Path
          key={i}
          points={run}
          stroke={shade(OCEAN, "left")}
          strokeWidth="1.5"
        />
      ))}

      <g transform={tangent(0.22)} stroke={PIN} strokeWidth="1.5">
        <circle r="1" className="iso-domain-ping" />
        <circle
          r="1"
          className="iso-domain-ping"
          style={{ animationDelay: "0.35s" }}
        />
      </g>

      <g className="iso-domain-pin">
        <Path
          points={[SPOT, HEAD]}
          stroke="var(--muted-foreground)"
          strokeWidth="2"
        />
        <circle cx={hx} cy={hy} r="9" fill={PIN} stroke={PIN} />
      </g>
    </IsoArt>
  );
}
