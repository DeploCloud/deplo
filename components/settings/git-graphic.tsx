import type * as React from "react";
import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  Path,
  UNIT,
  fit,
  floor,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [-0.3, -0.4, 0], size: [5.6, 1.6, 0] };
const HOST: BoxShape = { at: [0, 0, 0], size: [2, 0.3, 2.4] };
const LIST: BoxShape = { at: [3, 0, 0], size: [2, 0.3, 2.4] };
const COPY: BoxShape = { at: [0.25, 0.35, 1.05], size: [1.5, 0.2, 0.42] };
const ROWS = [1.8, 1.26, 0.72];

/** One repository row: a dot and a name, in the face's plane. */
function Row({
  box,
  z,
  fill,
  className,
  style,
}: {
  box: BoxShape;
  z: number;
  fill: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [x, y] = box.at;
  return (
    <Decal face="left" at={[x, y + box.size[1], z]}>
      <g className={className} style={style}>
        <circle cx={0.3 * UNIT} cy={0} r={0.09 * UNIT} fill={fill} />
        <rect
          x={0.48 * UNIT}
          y={-0.06 * UNIT}
          width={1.2 * UNIT}
          height={0.12 * UNIT}
          rx={0.06 * UNIT}
          fill={fill}
        />
      </g>
    </Decal>
  );
}

export function GitGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A repository being copied from a git host into a list of repositories"
      view={fit([FLOOR, HOST, LIST], 10)}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Path
        points={[
          [2, 0.6, 0],
          [3, 0.6, 0],
        ]}
        stroke="var(--violet)"
        strokeWidth="1.5"
        strokeDasharray="6 2"
        className="iso-march"
      />

      <Box {...HOST}>
        <FaceRect
          box={HOST}
          face="left"
          u={[0, 1]}
          v={[0.88, 0.9]}
          fill="var(--ring)"
        />
      </Box>
      {ROWS.map((z) => (
        <Row key={z} box={HOST} z={z} fill="var(--ring)" />
      ))}

      <Box {...LIST}>
        <FaceRect
          box={LIST}
          face="left"
          u={[0, 1]}
          v={[0.88, 0.9]}
          fill="var(--ring)"
        />
      </Box>
      {ROWS.map((z, i) => (
        <Row
          key={z}
          box={LIST}
          z={z}
          fill="var(--violet)"
          className="iso-git-row"
          style={{ animationDelay: `${i * 0.25}s` }}
        />
      ))}

      <g className="iso-git-copy">
        <Box {...COPY} tone={tone("var(--violet)")} />
      </g>
    </IsoArt>
  );
}
