import type * as React from "react";
import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  Legs,
  Path,
  fit,
  floor,
  plain,
  poly,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [3.4, 3, 0] };
const TRAY: BoxShape = { at: [0.3, 0.3, 1], size: [2.6, 1.8, 0.3] };
const Z = 1.3;
const HOLE = { x: [1.1, 2.1], y: [1.15, 1.75] };
// The first row is still falling, seen through the hole; two have landed.
const ROWS: BoxShape[] = [
  { at: [0.35, 0.55, 0.45], size: [1, 0.3, 0.08] },
  { at: [2.4, 1.3, 0], size: [0.3, 1, 0.08] },
  { at: [0.8, 2.45, 0], size: [1.1, 0.3, 0.08] },
];

const quad = (x0: number, x1: number, y0: number, y1: number, z = Z) =>
  poly([
    [x0, y0, z],
    [x1, y0, z],
    [x1, y1, z],
    [x0, y1, z],
  ]);

export function PaletteEmptyGraphic({ className }: { className?: string }) {
  const [hx0, hx1] = HOLE.x;
  const [hy0, hy1] = HOLE.y;
  return (
    <IsoArt
      label="A command palette with a hole in its floor and its rows fallen through"
      view={fit([FLOOR, TRAY])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <polygon points={quad(0, 2.9, 0, 2.1, 0)} fill="var(--border)" />
      {ROWS.map((row, i) => (
        <Box key={i} {...row}>
          <FaceRect
            box={row}
            face="top"
            u={row.size[0] > row.size[1] ? [0.1, 0.6] : [0.3, 0.7]}
            v={row.size[0] > row.size[1] ? [0.3, 0.7] : [0.1, 0.6]}
            fill={i === 0 ? "var(--info)" : "var(--ring)"}
          />
        </Box>
      ))}

      <Legs at={TRAY.at} size={TRAY.size} />
      {/* The top is drawn around the hole, so the floor and the rows show through it. */}
      <Box {...TRAY} tone={{ ...plain, top: "none" }} />
      <g fill="var(--iso-top)">
        <polygon points={quad(0.3, 2.9, 0.3, hy0)} />
        <polygon points={quad(0.3, 2.9, hy1, 2.1)} />
        <polygon points={quad(0.3, hx0, hy0, hy1)} />
        <polygon points={quad(hx1, 2.9, hy0, hy1)} />
      </g>
      <g stroke="var(--ring)" strokeWidth="1.5" strokeLinejoin="round">
        <polygon
          fill="var(--iso-left)"
          points={poly([
            [hx0, hy0, Z],
            [hx1, hy0, Z],
            [hx1, hy0, 1],
            [hx0, hy0, 1],
          ])}
        />
        <polygon
          fill="var(--iso-right)"
          points={poly([
            [hx0, hy0, Z],
            [hx0, hy1, Z],
            [hx0, hy1, 1],
            [hx0, hy0, 1],
          ])}
        />
        <polygon fill="none" points={quad(hx0, hx1, hy0, hy1)} />
        <polygon fill="none" points={quad(0.3, 2.9, 0.3, 2.1)} />
      </g>

      <Decal face="top" at={[0.45, 0.42, Z]}>
        <circle
          cx="9"
          cy="9"
          r="6.5"
          stroke="var(--muted-foreground)"
          strokeWidth="2"
        />
        <path
          d="M14 14l5 5"
          stroke="var(--muted-foreground)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </Decal>
      <polygon
        points={quad(0.95, 1.65, 0.52, 0.62)}
        fill="var(--muted-foreground)"
      />
      <polygon
        points={quad(1.72, 1.77, 0.46, 0.68)}
        fill="var(--violet)"
        className="iso-blink"
        style={{ "--iso-dur": "0.55s" } as React.CSSProperties}
      />
      <Path
        points={[
          [0.3, 0.88, Z],
          [2.9, 0.88, Z],
        ]}
        stroke="var(--ring)"
        strokeWidth="1.5"
      />
    </IsoArt>
  );
}
