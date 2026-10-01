import type * as React from "react";
import {
  Box,
  Decal,
  IsoArt,
  UNIT,
  fit,
  floor,
  plain,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

export type SecurityLevel = "weak" | "good" | "strong";

const LIT: Record<SecurityLevel, number> = { weak: 1, good: 2, strong: 3 };

// Three plates in one screen row: each slot steps +x and -y, so it moves right only.
const STEP = 1.7;
const PLATES: {
  w: number;
  h: number;
  glyph: (w: number, h: number) => React.ReactNode;
}[] = [
  {
    w: 1.3,
    h: 0.8,
    glyph: (w, h) =>
      [0.3, 0.5, 0.7].map((u) => (
        <circle key={u} cx={w * u} cy={h / 2} r={5} stroke="none" />
      )),
  },
  {
    w: 0.9,
    h: 1.3,
    glyph: (w, h) => (
      <>
        {[0.22, 0.5, 0.78].map((u) => (
          <rect
            key={u}
            x={w * u - 4}
            y={h * 0.24}
            width={8}
            height={h * 0.3}
            rx={3}
            stroke="none"
          />
        ))}
        <rect
          x={w * 0.18}
          y={h * 0.66}
          width={w * 0.64}
          height={6}
          rx={3}
          stroke="none"
        />
      </>
    ),
  },
  {
    w: 1.1,
    h: 1.15,
    glyph: (w, h) => {
      const cx = w / 2;
      const cy = h * 0.62;
      return (
        <g fill="none" strokeWidth="1.5" strokeLinecap="round">
          <path
            d={`M${cx - 20} ${h * 0.16}h40v14c0 12-9 19-20 23c-11-4-20-11-20-23z`}
            strokeLinejoin="round"
          />
          {[4, 9, 14].map((r) => (
            <path key={r} d={`M${cx - r} ${cy}a${r} ${r} 0 0 1 ${2 * r} 0`} />
          ))}
        </g>
      );
    },
  },
];

const slots = PLATES.map(({ w, h }, i): BoxShape => {
  const c = i * STEP;
  return { at: [c - w / 2, -c - 0.1, 0], size: [w, 0.2, h] };
});
const pads = PLATES.map(({ w }, i): BoxShape => {
  const c = i * STEP;
  return { at: [c - w / 2 - 0.2, -c - 0.4, 0], size: [w + 0.4, 0.8, 0] };
});

export function SecurityGraphic({
  level,
  className,
}: {
  level: SecurityLevel;
  className?: string;
}) {
  const lit = LIT[level];
  const color = level === "strong" ? "var(--success)" : "var(--chart-1)";

  return (
    <IsoArt
      label={`A shield of three plates, ${lit} of them closed`}
      view={fit([...slots, ...pads], 6)}
      className={cn("h-full w-full", className)}
    >
      {PLATES.map(({ w, h, glyph }, i) => {
        const on = lit > i;
        const { at, size } = slots[i];
        return (
          <g key={i}>
            <Box {...pads[i]} tone={floor} />
            <Box at={at} size={size} tone={on ? tone(color) : plain}>
              <Decal face="left" at={[at[0], at[1] + size[1], at[2] + size[2]]}>
                <g
                  fill={on ? color : "var(--ring)"}
                  stroke={on ? color : "var(--ring)"}
                >
                  {glyph(w * UNIT, h * UNIT)}
                </g>
              </Decal>
            </Box>
          </g>
        );
      })}
    </IsoArt>
  );
}
