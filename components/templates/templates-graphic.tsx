import type * as React from "react";
import {
  Box,
  FaceRect,
  IsoArt,
  IsoGrid,
  Legs,
  Path,
  Ring,
  Tick,
  beat,
  fit,
  floor,
  plain,
  shade,
  tone,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { KeepTime } from "@/components/iso/keep-time";
import { cn } from "@/lib/utils";

// Whole grid steps throughout, so the backdrop's lines run along every edge.
const PLATFORM: BoxShape = { at: [-2, -2, 0], size: [4, 5, 0] };
const SHEET: BoxShape = { at: [-2, -2, 0], size: [2, 5, 0.15] };
// A compose file's rows, top to bottom: [start, end, colour]; a coloured row is a service.
const ROWS: [number, number, string | null][] = [
  [0.08, 0.42, null],
  [0.18, 0.5, "var(--success)"],
  [0.28, 0.82, null],
  [0.28, 0.66, null],
  [0.18, 0.44, "var(--info)"],
  [0.28, 0.76, null],
  [0.18, 0.56, "var(--warning)"],
  [0.28, 0.7, null],
];
const SERVICES = [
  { y: -2, color: "var(--success)" },
  { y: 0, color: "var(--info)" },
  { y: 2, color: "var(--warning)" },
];

function Container({ at, color }: { at: P; color: string }) {
  const box: BoxShape = { at, size: [1, 1, 1] };
  return (
    <Box {...box} tone={tone(color)}>
      {[0.25, 0.5, 0.75].map((u) => (
        <FaceRect
          key={u}
          box={box}
          face="left"
          u={[u - 0.02, u + 0.02]}
          v={[0.12, 0.88]}
          fill={shade(color, "right")}
        />
      ))}
      <FaceRect
        box={box}
        face="right"
        u={[0.66, 0.84]}
        v={[0.72, 0.84]}
        fill="var(--foreground)"
        className="iso-blink"
        style={beat(at[1] + 3)}
      />
    </Box>
  );
}

/** The template catalog's hero: one compose file fanning out into running services. */
export function TemplatesGraphic({ className }: { className?: string }) {
  return (
    <KeepTime>
      <IsoArt
        label="A compose file turning into three running services"
        view={fit([{ at: [-2, -2, -1], size: [4, 5, 2.2] }])}
        className={cn("h-32 w-auto", className)}
      >
        <IsoGrid at={[0, 0.5, 0]} radius={560} />
        <Legs at={PLATFORM.at} size={PLATFORM.size} />
        <Box {...PLATFORM} tone={floor} />

        <Box {...SHEET} tone={plain}>
          {ROWS.map(([from, to, color], i) => {
            const v = 0.08 + i * 0.11;
            return (
              <FaceRect
                key={i}
                box={SHEET}
                face="top"
                u={[v, v + 0.035]}
                v={[from, to]}
                fill={color ?? "var(--ring)"}
                className={cn(color && "iso-blink")}
                style={color ? beat(i) : undefined}
              />
            );
          })}
        </Box>

        {SERVICES.map(({ y }) => (
          <Path
            key={y}
            points={[
              [0, y + 0.5, 0],
              [1, y + 0.5, 0],
            ]}
            stroke="var(--ring)"
            strokeWidth="1.5"
            strokeDasharray="6 2"
            className="iso-march"
          />
        ))}

        {SERVICES.map(({ y, color }, i) => (
          <g key={y}>
            <Box
              at={[1, y, 0]}
              size={[1, 1, 0]}
              tone={{
                top: shade(color),
                left: shade(color, "right"),
                right: shade(color, "right"),
                stroke: color,
              }}
            />
            <Ring
              at={[1, y, 0]}
              size={[1, 1, 0]}
              color={color}
              className="iso-wave"
              style={beat(i, [2.4, 2.4], [0.6 + i * 0.5, 0.6 + i * 0.5])}
            />
            <g
              className="iso-tpl-drop"
              style={
                { animationDelay: `${0.2 + i * 0.25}s` } as React.CSSProperties
              }
            >
              <Container at={[1, y, 0]} color={color} />
            </g>
          </g>
        ))}

        <Tick at={[-2, -2, 3]} />
        <Tick at={[2, 3, 0]} />
        <Tick at={[-2, 3, -1]} />
      </IsoArt>
    </KeepTime>
  );
}
