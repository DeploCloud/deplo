import {
  Box,
  Decal,
  Disc,
  FaceRect,
  IsoArt,
  UNIT,
  fit,
  floor,
  plain,
  poly,
  shade,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [2.4, 2.4, 0] };
const PAD: BoxShape = { at: [0.4, 0.4, 0], size: [1.6, 1.6, 0.2] };
const BODY: BoxShape = { at: [0.75, 0.75, 0.55], size: [0.9, 0.9, 1.4] };
const NOSE = "var(--violet)";
const FLAME = "var(--warning)";

const C = 1.2;
const BASE = 0.55;
const TOP = 1.95;
const APEX: P = [C, C, 2.65];

/** A fin in the vertical plane through the body's centre, pointing along `dir`. */
function Fin({ dir }: { dir: "x" | "y" | "-x" | "-y" }) {
  const sign = dir.startsWith("-") ? -1 : 1;
  const edge = C + sign * 0.45;
  const tip = edge + sign * 0.45;
  const along = (v: number, z: number): P =>
    dir.endsWith("x") ? [v, C, z] : [C, v, z];
  const side = dir.endsWith("x") ? "left" : "right";
  return (
    <polygon
      fill={shade(NOSE, side)}
      stroke={NOSE}
      strokeWidth="1.5"
      strokeLinejoin="round"
      points={poly([along(edge, 0.2), along(tip, 0.2), along(edge, 1.2)])}
    />
  );
}

/** A downward pyramid under the nozzle; two lengths alternate as the flicker. */
function Flame({ to, className }: { to: number; className: string }) {
  const a = C - 0.3;
  const b = C + 0.3;
  const apex: P = [C, C, to];
  return (
    <g
      className={className}
      stroke={FLAME}
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <polygon
        fill={shade(FLAME, "left")}
        points={poly([[a, b, BASE], [b, b, BASE], apex])}
      />
      <polygon
        fill={shade(FLAME, "right")}
        points={poly([[b, a, BASE], [b, b, BASE], apex])}
      />
    </g>
  );
}

export function AppsGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A rocket lifting off from its launch pad"
      view={fit([FLOOR, { at: [0.75, 0.75, 0.55], size: [0.9, 0.9, 3.1] }])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Box {...PAD} />
      {(
        [
          [0.75, 1.65],
          [1.65, 0.75],
        ] as const
      ).map(([x, y]) => (
        <Disc
          key={x}
          at={[x, y, 0.2]}
          r={0.2}
          className="iso-rocket-smoke fill-border stroke-ring"
          strokeWidth="1.5"
        />
      ))}

      <g className="iso-rocket">
        <Fin dir="-x" />
        <Fin dir="-y" />
        <Flame to={-0.2} className="iso-rocket-flame" />
        <Flame to={-0.55} className="iso-rocket-flame iso-rocket-flame-long" />
        <Box {...BODY} tone={plain}>
          {(["left", "right"] as const).map((face) => (
            <FaceRect
              key={face}
              box={BODY}
              face={face}
              u={[0, 1]}
              v={[0.12, 0.2]}
              fill={NOSE}
            />
          ))}
          <Decal face="left" at={[C - 0.2, 1.65, 1.75]}>
            <circle
              cx={0.2 * UNIT}
              cy={0.2 * UNIT}
              r={0.18 * UNIT}
              fill={shade("var(--info)", "right")}
              stroke="var(--info)"
            />
          </Decal>
        </Box>
        <Fin dir="x" />
        <Fin dir="y" />
        <g stroke={NOSE} strokeWidth="1.5" strokeLinejoin="round">
          <polygon
            fill={NOSE}
            points={poly([[0.75, 1.65, TOP], [1.65, 1.65, TOP], APEX])}
          />
          <polygon
            fill={shade(NOSE, "left")}
            points={poly([[1.65, 0.75, TOP], [1.65, 1.65, TOP], APEX])}
          />
        </g>
      </g>
    </IsoArt>
  );
}
