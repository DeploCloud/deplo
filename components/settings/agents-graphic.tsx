import {
  Box,
  Decal,
  IsoArt,
  Path,
  UNIT,
  fit,
  floor,
  tone,
  type P,
} from "@/components/iso/iso";
import { DeploCube } from "@/components/iso/parts";
import { cn } from "@/lib/utils";

const H = 1.3;
const SOCKET_AT: P = [1.75, -1.75, 0];
const TILE: P = [0.7, 0.16, 0.7];

const u = (n: number) => n * UNIT;

// Three agents, each its own colour: no brand marks, just a shape apiece.
const AGENTS: { at: P; color: string; glyph: string }[] = [
  {
    at: [-0.4, 0.2, 0],
    color: "#d97757",
    glyph: `M${u(0.375)} ${u(0.16)}V${u(0.59)}M${u(0.16)} ${u(0.375)}H${u(0.59)}M${u(0.23)} ${u(0.23)}L${u(0.52)} ${u(0.52)}M${u(0.52)} ${u(0.23)}L${u(0.23)} ${u(0.52)}`,
  },
  {
    at: [0.1, -0.3, 0.55],
    color: "var(--chart-1)",
    glyph: `M${u(0.185)} ${u(0.375)}a${u(0.19)} ${u(0.19)} 0 1 0 ${u(0.38)} 0a${u(0.19)} ${u(0.19)} 0 1 0 ${u(-0.38)} 0`,
  },
  {
    at: [0.6, -0.8, 0],
    color: "var(--violet)",
    glyph: `M${u(0.375)} ${u(0.16)}L${u(0.6)} ${u(0.57)}H${u(0.15)}Z`,
  },
];

const FLOORS: P[] = [
  [-0.3, -0.3, 0],
  [1.3, -1.9, 0],
  [2.9, -3.5, 0],
];

export function AgentsGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="Several AI agents reaching Deplo through one door"
      view={fit(
        [
          { at: [0, 0, 0], size: [1.6, 0.3, H + 0.5] },
          { at: [-0.3, -0.3, 0], size: [2, 0.9, 0] },
          { at: [3.0, -3.5, 0], size: [1.4, 0.9, H + 0.2] },
        ],
        6,
      )}
      className={cn("h-full w-full", className)}
    >
      {FLOORS.map((at) => (
        <Box key={at.join()} at={at} size={[2.2, 0.9, 0]} tone={floor} />
      ))}

      {AGENTS.map(({ at, color, glyph }) => (
        <Box key={color} at={at} size={TILE} tone={tone(color)}>
          <Decal face="left" at={[at[0] - 0.02, at[1] + TILE[1], at[2] + 0.72]}>
            <path
              d={glyph}
              fill="none"
              stroke="#ffffff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Decal>
        </Box>
      ))}

      {(
        [
          [0.3, 0.36, 0.35],
          [0.8, -0.14, 0.9],
          [1.3, -0.64, 0.35],
        ] as P[]
      ).map((from) => (
        <Path
          key={from.join()}
          points={[from, [2.0, -1.45, 0.65]]}
          stroke="var(--ring)"
          strokeWidth="1"
          strokeDasharray="4 4"
        />
      ))}

      {/* The one door every agent goes through: Deplo's MCP server. */}
      <Box at={SOCKET_AT} size={[1.2, 0.3, H]}>
        <Decal face="left" at={[SOCKET_AT[0], SOCKET_AT[1] + 0.3, H]}>
          <g
            fill="none"
            stroke="var(--muted-foreground)"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <rect
              x={u(0.3)}
              y={u(0.35)}
              width={u(0.6)}
              height={u(0.6)}
              rx={u(0.1)}
            />
            <path
              d={`M${u(0.48)} ${u(0.55)}V${u(0.75)}M${u(0.72)} ${u(0.55)}V${u(0.75)}`}
            />
          </g>
        </Decal>
      </Box>

      <Decal face="left" at={[3.08, -2.05, 0.85]}>
        <path
          d={`M0 0L${u(0.22)} ${u(0.2)}L0 ${u(0.4)}`}
          stroke="var(--ring)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Decal>

      <DeploCube at={[3.3, -3.45, 0]} size={1.05} />
    </IsoArt>
  );
}
