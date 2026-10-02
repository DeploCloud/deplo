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
  plain,
  tone,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { DEPLO, Mark } from "@/components/iso/parts";
import { cn } from "@/lib/utils";
import type { LogoAccent } from "@/lib/templates/logo-color";

export function RobotMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn("size-4 shrink-0", className)}
    >
      <line
        x1="12"
        y1="6"
        x2="12"
        y2="4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="2.6" r="1.5" fill="currentColor" />
      <rect
        x="4"
        y="6"
        width="16"
        height="12"
        rx="4.5"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle cx="9.2" cy="12" r="1.4" fill="currentColor" />
      <circle cx="14.8" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}

const LABEL: Record<RobotState, string> = {
  idle: "A robot waiting to be connected to Deplo",
  key: "A robot holding a key, ready to be given permissions",
  reaching: "A robot reaching a cable toward Deplo",
  connected: "A robot plugged into Deplo",
};

export type RobotState = "idle" | "key" | "reaching" | "connected";

const INK = "var(--deplo-robot-ink)";
const LIVE = "var(--deplo-robot-live)";

const FLOOR: BoxShape = { at: [-0.4, -0.3, 0], size: [4.5, 3.2, 0] };
const DEPLO_BOX: BoxShape = { at: [2.5, 0, 0], size: [1.3, 1.3, 2] };
const BODY: BoxShape = { at: [0, 1.6, 0], size: [1.2, 1, 1] };
const HEAD: BoxShape = { at: [0, 1.6, 1.15], size: [1.2, 1, 0.85] };
const ARM: BoxShape = { at: [1.2, 2, 0.45], size: [0.55, 0.22, 0.2] };
// The cable leaves the hand along +x, then turns -y into the port on Deplo's front.
const HAND: P = [1.75, 2.11, 0.55];
const CORNER: P = [2.76, 2.11, 0.55];
const PORT: P = [2.76, 1.3, 0.55];

export function RobotGraphic({
  state = "idle",
  accent,
  className,
}: {
  state?: RobotState;
  accent?: LogoAccent;
  className?: string;
}) {
  const live = state === "connected";
  const cable = state === "reaching" || live;
  const ink =
    accent?.hue !== undefined
      ? ({
          "--deplo-robot-ink": `oklch(var(--deplo-robot-l) var(--deplo-robot-c) ${accent.hue})`,
          "--deplo-robot-live": "var(--deplo-robot-ink)",
        } as React.CSSProperties)
      : undefined;
  const lit = live ? LIVE : INK;
  const shell = { ...plain, stroke: INK };
  const headW = HEAD.size[0] * UNIT;
  const headH = HEAD.size[2] * UNIT;

  return (
    <IsoArt
      label={LABEL[state]}
      view={fit([FLOOR, DEPLO_BOX, { at: [0, 1.6, 0], size: [1.2, 1, 2.6] }])}
      style={ink}
      className={cn("h-32 w-auto", className)}
    >
      <Box {...FLOOR} tone={floor} />

      <Box {...DEPLO_BOX} tone={DEPLO}>
        <Mark at={[2.8, 1.3, 1.82]} size={0.65} />
        {[0.42, 0.52].map((v) => (
          <FaceRect
            key={v}
            box={DEPLO_BOX}
            face="left"
            u={[0.45, 0.85]}
            v={[v, v + 0.025]}
            fill={DEPLO.right}
          />
        ))}
        <FaceRect
          box={DEPLO_BOX}
          face="left"
          u={[0.1, 0.3]}
          v={[0.2, 0.35]}
          fill={live ? LIVE : DEPLO.right}
          stroke={live ? LIVE : DEPLO.stroke}
        />
        {live && (
          <FaceRect
            box={DEPLO_BOX}
            face="left"
            u={[0.1, 0.3]}
            v={[0.2, 0.35]}
            fill="none"
            stroke={LIVE}
            className="iso-wave iso-robot-halo"
          />
        )}
      </Box>

      {cable && (
        <g stroke={INK} strokeWidth="2.5">
          <Path
            points={[HAND, CORNER]}
            className={cn(!live && "iso-robot-cable-a")}
          />
          <Path
            points={[CORNER, PORT]}
            className={cn(!live && "iso-robot-cable-b")}
          />
        </g>
      )}

      <Box {...BODY} tone={shell}>
        <FaceRect
          box={BODY}
          face="left"
          u={[0.25, 0.75]}
          v={[0.35, 0.7]}
          fill="var(--iso-floor)"
        />
        <FaceRect
          box={BODY}
          face="left"
          u={[0.33, 0.45]}
          v={[0.45, 0.6]}
          fill={lit}
          className={cn(state === "key" && "iso-blink")}
        />
      </Box>
      <Box {...ARM} tone={shell} />
      <Box at={[0.5, 2, 1]} size={[0.2, 0.2, 0.15]} tone={shell} />
      <Box {...HEAD} tone={shell}>
        <Decal face="left" at={[0, 2.6, 2]}>
          <g
            fill={lit}
            stroke="none"
            className={cn(state === "idle" && "iso-robot-eyes")}
          >
            <circle cx={headW * 0.3} cy={headH * 0.45} r={6} />
            <circle cx={headW * 0.7} cy={headH * 0.45} r={6} />
          </g>
        </Decal>
      </Box>
      <Path
        points={[
          [0.6, 2.1, 2],
          [0.6, 2.1, 2.35],
        ]}
        stroke="var(--ring)"
        strokeWidth="2.5"
      />
      <Box
        at={[0.5, 2, 2.35]}
        size={[0.2, 0.2, 0.2]}
        tone={tone(lit)}
        className={cn(
          state === "idle" && "iso-robot-antenna",
          state === "key" && "iso-robot-blip",
        )}
      />

      {state === "key" && (
        <Decal face="left" at={[HAND[0], 2.22, HAND[2]]}>
          <g
            stroke={INK}
            strokeWidth="2.5"
            strokeLinecap="round"
            className="iso-robot-key"
          >
            <circle cx={7} cy={0} r={7} />
            <path d="M14 0h18M26 0v8" />
          </g>
        </Decal>
      )}
    </IsoArt>
  );
}
