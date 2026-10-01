import type * as React from "react";
import { cn } from "@/lib/utils";

/** One grid step: every edge of a cube is UNIT long on screen, true isometric. */
export const UNIT = 32 * Math.sqrt(3);
const RUN = 48;
const COS = RUN / UNIT;

/** A point in grid steps: x runs down-right, y down-left, z up. */
export type P = [number, number, number];
export type BoxShape = { at: P; size: P };

export const pt = ([x, y, z]: P): [number, number] => [
  (x - y) * RUN,
  ((x + y) / 2 - z) * UNIT,
];

const fmt = (p: P) =>
  pt(p)
    .map((n) => Math.round(n * 100) / 100)
    .join(",");

export const poly = (points: P[]) => points.map(fmt).join(" ");

export type Tone = { top: string; left: string; right: string; stroke: string };

/** The neutral solid: three theme greys, edged in `--ring`. */
export const plain: Tone = {
  top: "var(--iso-top)",
  left: "var(--iso-left)",
  right: "var(--iso-right)",
  stroke: "var(--ring)",
};

/** A recessive solid for furniture: pads, belts, shelves. */
export const floor: Tone = { ...plain, top: "var(--iso-floor)" };

/** The outline of something that is not there: no fill, a muted edge. Pair with `wire`. */
export const ghost: Tone = {
  top: "none",
  left: "none",
  right: "none",
  stroke: "var(--muted-foreground)",
};

/** Dashes every edge inside it: the brand's wireframe for an empty slot. */
export const wire =
  "[&_polygon]:[stroke-dasharray:4_4] [&_path]:[stroke-dasharray:4_4] [&_ellipse]:[stroke-dasharray:4_4]";

const mix = (color: string, amount: string) =>
  `color-mix(in srgb, ${color} var(${amount}), var(--iso-base))`;

/** A coloured solid: the colour on top, the two sides mixed toward the theme base. */
export const tone = (color: string): Tone => ({
  top: color,
  left: mix(color, "--iso-shade-left"),
  right: mix(color, "--iso-shade-right"),
  stroke: color,
});

/** A solid's side in a colour, for a decal or a lit slot. */
export const shade = (color: string, side: "left" | "right" = "left") =>
  mix(color, side === "left" ? "--iso-shade-left" : "--iso-shade-right");

type Styled = { className?: string; style?: React.CSSProperties };

/** The three visible faces of a cuboid: top, left (y+d) and right (x+w). */
export function Box({
  at: [x, y, z],
  size: [w, d, h],
  tone: t = plain,
  className,
  style,
  children,
}: BoxShape & { tone?: Tone; children?: React.ReactNode } & Styled) {
  return (
    <g
      stroke={t.stroke}
      strokeWidth="1.5"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {h > 0 && (
        <>
          <polygon
            fill={t.left}
            points={poly([
              [x, y + d, z],
              [x + w, y + d, z],
              [x + w, y + d, z + h],
              [x, y + d, z + h],
            ])}
          />
          <polygon
            fill={t.right}
            points={poly([
              [x + w, y, z],
              [x + w, y + d, z],
              [x + w, y + d, z + h],
              [x + w, y, z + h],
            ])}
          />
        </>
      )}
      <polygon
        fill={t.top}
        points={poly([
          [x, y, z + h],
          [x + w, y, z + h],
          [x + w, y + d, z + h],
          [x, y + d, z + h],
        ])}
      />
      {children}
    </g>
  );
}

export type Face = "left" | "right" | "top";

/** A rectangle on one face of `box`, in fractions: u across, v from the bottom up (top face: v along y). */
export function FaceRect({
  box: {
    at: [x, y, z],
    size: [w, d, h],
  },
  face,
  u: [u0, u1],
  v: [v0, v1],
  fill,
  stroke = "none",
  className,
  style,
}: {
  box: BoxShape;
  face: Face;
  u: readonly [number, number];
  v: readonly [number, number];
  fill: string;
  stroke?: string;
} & Styled) {
  const at = (u: number, v: number): P =>
    face === "left"
      ? [x + u * w, y + d, z + v * h]
      : face === "right"
        ? [x + w, y + d - u * d, z + v * h]
        : [x + u * w, y + v * d, z + h];
  return (
    <polygon
      fill={fill}
      stroke={stroke}
      strokeWidth="1.5"
      strokeLinejoin="round"
      className={className}
      style={style}
      points={poly([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)])}
    />
  );
}

const PLANE: Record<Face, [number, number, number, number]> = {
  left: [COS, 0.5, 0, 1],
  right: [COS, -0.5, 0, 1],
  top: [COS, 0.5, -COS, 0.5],
};

/**
 * A flat 2D drawing laid on an isometric plane. `at` is the drawing's top-left
 * corner; one local px is one px of edge, so a grid step is UNIT px across.
 * Left: u along +x. Right: u along -y. Top: u along +x, v along +y.
 */
export function Decal({
  face,
  at,
  children,
  className,
  style,
}: { face: Face; at: P; children: React.ReactNode } & Styled) {
  const [a, b, c, d] = PLANE[face];
  const [e, f] = pt(at);
  return (
    <g
      transform={`matrix(${a} ${b} ${c} ${d} ${e} ${f})`}
      className={className}
      style={style}
    >
      {children}
    </g>
  );
}

/** A line through grid points: flows, cables, traces. */
export function Path({
  points,
  ...rest
}: { points: P[] } & Omit<React.SVGProps<SVGPathElement>, "points">) {
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${fmt(p).replace(",", " ")}`)
    .join("");
  return <path d={d} fill="none" strokeLinecap="round" {...rest} />;
}

function Dashed({
  from,
  to,
  color = "var(--ring)",
  className,
}: {
  from: P;
  to: P;
  color?: string;
  className?: string;
}) {
  return (
    <Path
      points={[from, to]}
      stroke={color}
      strokeWidth="1"
      strokeDasharray="4 4"
      className={className}
    />
  );
}

/** The brand's dimension cross, no label. */
export function Tick({ at }: { at: P }) {
  const [x, y] = pt(at);
  return (
    <path
      d={`M${x - 5} ${y}h10M${x} ${y - 5}v10`}
      className="stroke-muted-foreground"
      strokeWidth="1"
    />
  );
}

/** The dashed legs under a slab, down to the plane below. */
export function Legs({
  at: [x, y, z],
  size: [w, d],
  drop = 1,
}: {
  at: P;
  size: P;
  drop?: number;
}) {
  return (
    <>
      <Dashed from={[x, y + d, z]} to={[x, y + d, z - drop]} />
      <Dashed from={[x + w, y + d, z]} to={[x + w, y + d, z - drop]} />
      <Dashed from={[x + w, y, z]} to={[x + w, y, z - drop]} />
    </>
  );
}

/** A flat outline on the plane at `at`'s height: the ring a landing throws off. */
export function Ring({
  at: [x, y, z],
  size: [w, d],
  color,
  className,
  style,
}: { at: P; size: P; color: string } & Styled) {
  return (
    <polygon
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      className={className}
      style={style}
      points={poly([
        [x, y, z],
        [x + w, y, z],
        [x + w, y + d, z],
        [x, y + d, z],
      ])}
    />
  );
}

const RX = RUN * Math.SQRT2;
const RY = UNIT / Math.SQRT2;

/** An upright cylinder standing on the plane at `at` (its centre), `r` grid steps wide. */
export function Cylinder({
  at,
  r,
  h,
  tone: t = plain,
  className,
  style,
  children,
}: {
  at: P;
  r: number;
  h: number;
  tone?: Tone;
  children?: React.ReactNode;
} & Styled) {
  const [cx, cy] = pt(at);
  const rx = RX * r;
  const ry = RY * r;
  const top = cy - h * UNIT;
  return (
    <g stroke={t.stroke} strokeWidth="1.5" className={className} style={style}>
      <path
        d={`M${cx - rx} ${top}V${cy}A${rx} ${ry} 0 0 0 ${cx + rx} ${cy}V${top}`}
        fill={t.left}
      />
      <ellipse cx={cx} cy={top} rx={rx} ry={ry} fill={t.top} />
      {children}
    </g>
  );
}

/** A flat isometric circle on the plane at `at`. */
export function Disc({
  at,
  r,
  ...rest
}: { at: P; r: number } & React.SVGProps<SVGEllipseElement>) {
  const [cx, cy] = pt(at);
  return <ellipse cx={cx} cy={cy} rx={RX * r} ry={RY * r} {...rest} />;
}

/** The viewBox that holds every corner of `boxes`, plus `pad` px all round. */
export function fit(boxes: BoxShape[], pad = 12) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const {
    at: [x, y, z],
    size: [w, d, h],
  } of boxes)
    for (const dx of [0, w])
      for (const dy of [0, d])
        for (const dz of [0, h]) {
          const [sx, sy] = pt([x + dx, y + dy, z + dz]);
          xs.push(sx);
          ys.push(sy);
        }
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `${r(x0)} ${r(y0)} ${r(Math.max(...xs) + pad - x0)} ${r(Math.max(...ys) + pad - y0)}`;
}

const frac = (n: number) => n - Math.floor(n);

/** A deterministic per-element tempo, so no two loops in a drawing move in step. */
export function beat(
  seed: number,
  dur: [number, number] = [0.8, 1.6],
  delay: [number, number] = [0, 2],
): React.CSSProperties {
  const a = frac(seed * 0.618034 + 0.13);
  const b = frac(seed * 0.414214 + 0.57);
  return {
    "--iso-dur": `${(dur[0] + a * (dur[1] - dur[0])).toFixed(2)}s`,
    "--iso-delay": `${(delay[0] + b * (delay[1] - delay[0])).toFixed(2)}s`,
  } as React.CSSProperties;
}

/** The svg every isometric illustration draws in: hairlines stay 1.5px at any size. */
export function IsoArt({
  label,
  view,
  className,
  style,
  children,
}: {
  label: string;
  view: string;
  children: React.ReactNode;
} & Styled) {
  return (
    <svg
      viewBox={view}
      fill="none"
      role="img"
      aria-label={label}
      className={cn("iso-art overflow-visible", className)}
      style={style}
    >
      {children}
    </svg>
  );
}
