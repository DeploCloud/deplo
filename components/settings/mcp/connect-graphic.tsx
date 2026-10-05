import type * as React from "react";
import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  IsoGrid,
  Path,
  UNIT,
  fit,
  plain,
  pt,
  tone,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { DEPLO, Mark } from "@/components/iso/parts";
import { cn } from "@/lib/utils";
import { AGENTS, type AgentDef, type AgentId } from "./agents";

export type ConnectState = "idle" | "picked" | "reaching" | "connected";

const LABEL: Record<ConnectState, string> = {
  idle: "AI agents waiting around Deplo",
  picked: "One agent stepping forward to connect to Deplo",
  reaching: "A cable running from an agent to Deplo",
  connected: "An agent connected to Deplo, data flowing between them",
};

const LIVE = "var(--success)";
const CUBE: BoxShape = { at: [0, 0, 0], size: [1.3, 1.3, 1.7] };
const CENTRE: P = [0.65, 0.65, 0];
const TILE = 0.8;
const SLAB = 0.2;
const LIFT = 0.35;
// Four agents around Deplo; the one being connected always takes the slot facing its port.
const SLOTS: P[] = [
  [3.05, 0.25, 0],
  [-2.05, 0.25, 0],
  [0.25, -2.05, 0],
  [0.25, 2.55, 0],
];
const SEEN: AgentId[] = ["claude-web", "cursor", "vscode", "chatgpt"];
const CABLE_Z = 0.47;
const CABLE_FROM: P = [SLOTS[0][0], CENTRE[1], CABLE_Z];
const CABLE_TO: P = [CUBE.size[0], CENTRE[1], CABLE_Z];
// One packet's run along the cable, on screen.
const RUN = ((a, b) => [b[0] - a[0], b[1] - a[1]])(
  pt(CABLE_FROM),
  pt(CABLE_TO),
);
const MARK = TILE * UNIT * 0.5;

const middle = ([x, y]: P): P => [x + TILE / 2, y + TILE / 2, 0];

function AgentTile({
  agent,
  at,
  active,
  index,
}: {
  agent: AgentDef;
  at: P;
  active: boolean;
  index: number;
}) {
  const brand = active ? agent.brand : undefined;
  const Icon = agent.icon;
  return (
    <g
      className="iso-mcp-lift"
      style={{ translate: `0 ${active ? -LIFT * UNIT : 0}px` }}
    >
      <g
        className="iso-mcp-hover"
        style={{ "--iso-delay": `${index * -0.7}s` } as React.CSSProperties}
      >
        <Box
          at={at}
          size={[TILE, TILE, SLAB]}
          tone={brand ? tone(brand.bg) : plain}
        />
        <Decal face="top" at={[at[0], at[1], SLAB]}>
          <svg
            x={MARK / 2}
            y={MARK / 2}
            width={MARK}
            height={MARK}
            viewBox="0 0 24 24"
            style={{ color: brand ? brand.fg : "var(--ring)" }}
          >
            <Icon />
          </svg>
        </Decal>
      </g>
    </g>
  );
}

export function ConnectGraphic({
  state = "idle",
  agent,
  className,
}: {
  state?: ConnectState;
  agent?: AgentDef | null;
  className?: string;
}) {
  const picked = state !== "idle" && agent ? agent : null;
  const others = SEEN.filter((id) => id !== picked?.id)
    .slice(0, picked ? 3 : 4)
    .map((id) => AGENTS.find((a) => a.id === id)!);
  const [front, ...back] = picked ? [picked, ...others] : others;
  const cabled = state === "reaching" || state === "connected";
  const live = state === "connected";

  return (
    <IsoArt
      label={LABEL[state]}
      view={fit([
        CUBE,
        ...SLOTS.map((at) => ({
          at,
          size: [TILE, TILE, LIFT + SLAB] as P,
        })),
      ])}
      className={cn("h-32 w-auto", className)}
    >
      <IsoGrid at={CENTRE} radius={360} />

      {SLOTS.slice(1).map((at, i) => (
        <Path
          key={i}
          points={[middle(at), CENTRE]}
          stroke="var(--ring)"
          strokeDasharray="4 4"
        />
      ))}

      {back.map((a, i) => (
        <AgentTile
          key={a.id}
          agent={a}
          at={SLOTS[i + 1]}
          active={false}
          index={i + 1}
        />
      ))}

      <Path
        points={[CABLE_FROM, CABLE_TO]}
        stroke={live ? LIVE : "var(--ring)"}
        strokeWidth={cabled ? 2.5 : 1.5}
        strokeDasharray={cabled ? "1 1" : "4 4"}
        pathLength={cabled ? 1 : undefined}
        className={cn(cabled && "iso-mcp-cable")}
        style={cabled ? { vectorEffect: "none" } : undefined}
      />

      <Box {...CUBE} tone={DEPLO}>
        <Mark at={[0.3, 1.3, 1.55]} size={0.62} />
        <FaceRect
          box={CUBE}
          face="right"
          u={[0.4, 0.6]}
          v={[0.2, 0.35]}
          fill={live ? LIVE : DEPLO.right}
          stroke={live ? LIVE : DEPLO.stroke}
        />
        {live && (
          <FaceRect
            box={CUBE}
            face="right"
            u={[0.4, 0.6]}
            v={[0.2, 0.35]}
            fill="none"
            stroke={LIVE}
            className="iso-wave"
          />
        )}
      </Box>

      {live &&
        [0, 1, 2].map((n) => (
          <g
            key={n}
            className="iso-mcp-packet"
            style={
              {
                "--iso-mcp-run": `${RUN[0]}px ${RUN[1]}px`,
                animationDelay: `${n * 0.6}s`,
              } as React.CSSProperties
            }
          >
            <Box
              at={[CABLE_FROM[0] - 0.08, CENTRE[1] - 0.08, CABLE_Z - 0.06]}
              size={[0.16, 0.16, 0.12]}
              tone={tone(LIVE)}
            />
          </g>
        ))}

      <AgentTile
        // One element for the front slot, so a new pick lifts instead of remounting raised.
        key="front"
        agent={front}
        at={SLOTS[0]}
        active={picked !== null}
        index={0}
      />
    </IsoArt>
  );
}
