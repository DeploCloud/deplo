import type * as React from "react";
import { MARK_PATH } from "@/components/logo";
import {
  Box,
  Decal,
  FaceRect,
  UNIT,
  plain,
  type BoxShape,
  type P,
  type Tone,
} from "./iso";

/** Deplo's own block: white in both themes, as on deplo.build. */
export const DEPLO: Tone = {
  top: "#ffffff",
  left: "#e4e4e4",
  right: "#c9c9c9",
  stroke: "#8a8a8a",
};

/** The Deplo mark printed on a left face, `size` steps tall from its top-left corner `at`. */
export function Mark({
  at,
  size,
  fill = "#000",
  className,
}: {
  at: P;
  size: number;
  fill?: string;
  className?: string;
}) {
  return (
    <Decal face="left" at={at} className={className}>
      <path
        d={MARK_PATH}
        fill={fill}
        stroke="none"
        transform={`scale(${(size * UNIT) / 26})`}
      />
    </Decal>
  );
}

/** Deplo as a cube with its mark on the front. */
export function DeploCube({
  at: [x, y, z],
  size = 1,
  className,
  style,
}: {
  at: P;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <Box
      at={[x, y, z]}
      size={[size, size, size]}
      tone={DEPLO}
      className={className}
      style={style}
    >
      <Mark
        at={[x + 0.22 * size, y + size, z + 0.8 * size]}
        size={0.6 * size}
      />
    </Box>
  );
}

/**
 * A server: one bay per unit of height, an LED and a slot on the front, vents
 * on the side. `led` styles each bay's LED (fill, class, animation).
 */
export function Rack({
  box,
  bays = box.size[2],
  tone = plain,
  led = () => ({ fill: "var(--success)" }),
  children,
}: {
  box: BoxShape;
  bays?: number;
  tone?: Tone;
  led?: (bay: number) => {
    fill: string;
    className?: string;
    style?: React.CSSProperties;
  };
  children?: React.ReactNode;
}) {
  return (
    <Box {...box} tone={tone}>
      {Array.from({ length: bays }, (_, i) => {
        const v = (i + 0.5) / bays;
        const h = box.size[2];
        return (
          <g key={i}>
            {i > 0 && (
              <FaceRect
                box={box}
                face="left"
                u={[0, 1]}
                v={[i / bays - 0.02 / h, i / bays + 0.02 / h]}
                fill={tone.stroke}
              />
            )}
            <FaceRect
              box={box}
              face="left"
              u={[0.08, 0.16]}
              v={[v - 0.1 / h, v + 0.1 / h]}
              {...led(i)}
            />
            <FaceRect
              box={box}
              face="left"
              u={[0.55, 0.9]}
              v={[v - 0.035 / h, v + 0.035 / h]}
              fill="var(--border)"
            />
            <FaceRect
              box={box}
              face="right"
              u={[0.25, 0.75]}
              v={[v - 0.035 / h, v + 0.035 / h]}
              fill="var(--border)"
            />
          </g>
        );
      })}
      {children}
    </Box>
  );
}
