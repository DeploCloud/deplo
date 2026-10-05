import type * as React from "react";
import {
  Box,
  Cylinder,
  Disc,
  FaceRect,
  IsoArt,
  Path,
  UNIT,
  fit,
  floor,
  plain,
  pt,
  shade,
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
  idle: "A friendly robot floating by, waiting to be connected to Deplo",
  key: "A robot holding up a key, ready to be given permissions",
  reaching: "A robot reaching a cable toward Deplo",
  connected: "A happy robot plugged into Deplo",
};

export type RobotState = "idle" | "key" | "reaching" | "connected";

const INK = "var(--deplo-robot-ink)";
const LIVE = "var(--deplo-robot-live)";

const FLOOR: BoxShape = { at: [-0.4, -0.3, 0], size: [4.5, 3.2, 0] };
const DEPLO_BOX: BoxShape = { at: [2.5, 0, 0], size: [1.3, 1.3, 2] };
// The robot floats over its own shadow; everything below hangs off this centre.
const [CX, CY] = [0.6, 2.1];
const BODY = { z: 0.3, r: 0.44, h: 0.5 };
const HEAD = { z: 0.86, r: 0.62, h: 0.52 };
// The dome rises this far over the head's rim, in grid steps: past the rim's own back edge.
const DOME = 0.58;
const ANTENNA_TOP = HEAD.z + HEAD.h + DOME + 0.3;
// It turns a little toward Deplo: the face sits just right of the head's front.
const TURN = 38;
const HAND_Z = 0.55;
const NEAR_HAND: P = [CX + 0.1, CY + 0.72, HAND_Z];
const REST_HAND: P = [CX + 0.74, CY - 0.06, HAND_Z + 0.08];
const REACH_HAND: P = [CX + 0.9, CY - 0.06, HAND_Z];
// The cable leaves the hand along +x, then turns -y into the port on Deplo's front.
const CORNER: P = [2.76, REACH_HAND[1], HAND_Z];
const PORT: P = [2.76, 1.3, HAND_Z];

/** A flat drawing on the vertical plane tangent to a cylinder, `deg` round from +x. */
function Facing({
  at,
  deg,
  children,
  className,
}: {
  at: P;
  deg: number;
  children: React.ReactNode;
  className?: string;
}) {
  const rad = (deg * Math.PI) / 180;
  const [dx, dy] = pt([Math.sin(rad), -Math.cos(rad), 0]);
  const [e, f] = pt(at);
  return (
    <g
      transform={`matrix(${dx / UNIT} ${dy / UNIT} 0 1 ${e} ${f})`}
      className={className}
    >
      {children}
    </g>
  );
}

const onSurface = (r: number, z: number, deg = TURN): P => {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad), z];
};

function Sphere({ at, r, fill }: { at: P; r: number; fill: string }) {
  const [x, y] = pt(at);
  return (
    <circle cx={x} cy={y} r={r} fill={fill} stroke={INK} strokeWidth="1.5" />
  );
}

/** The rounded cap on the head: half an ellipse over the rim, drawn on screen. */
function Dome({ fill }: { fill: string }) {
  const [cx, top] = pt([CX, CY, HEAD.z + HEAD.h]);
  const [rx] = pt([HEAD.r * Math.SQRT1_2, -HEAD.r * Math.SQRT1_2, 0]);
  const ry = DOME * UNIT;
  return (
    <path
      d={`M${cx - rx} ${top}A${rx} ${ry} 0 0 1 ${cx + rx} ${top}`}
      fill={fill}
      stroke={INK}
      strokeWidth="1.5"
    />
  );
}

function Face({ state, lit }: { state: RobotState; lit: string }) {
  const happy = state === "connected";
  return (
    <>
      <rect
        x={-22}
        y={-14}
        width={44}
        height={28}
        rx={14}
        fill="var(--iso-base)"
        stroke={INK}
        strokeWidth="1.5"
      />
      {happy ? (
        <g stroke={lit} strokeWidth="3" strokeLinecap="round" fill="none">
          <path d="M-15 -1q4 -7 8 0M7 -1q4 -7 8 0" />
          <path d="M-6 5q6 5 12 0" />
        </g>
      ) : (
        <g
          fill={lit}
          stroke="none"
          className={cn(
            state === "idle" && "iso-robot-look",
            state === "key" && "iso-robot-glance",
          )}
        >
          <g className={cn(state !== "reaching" && "iso-robot-blink")}>
            <rect
              x={-14}
              y={state === "reaching" ? -4 : -8}
              width={7}
              height={state === "reaching" ? 6 : 12}
              rx={3.5}
            />
            <rect
              x={7}
              y={state === "reaching" ? -4 : -8}
              width={7}
              height={state === "reaching" ? 6 : 12}
              rx={3.5}
            />
          </g>
          {state === "key" && (
            <path
              d="M-4 7q4 3 8 0"
              stroke={lit}
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          )}
        </g>
      )}
      {happy && (
        <g fill={shade(LIVE)} stroke="none">
          <ellipse cx={-15} cy={7} rx={3} ry={2} />
          <ellipse cx={15} cy={7} rx={3} ry={2} />
        </g>
      )}
    </>
  );
}

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
  const floating = !cable;
  const ink =
    accent?.hue !== undefined
      ? ({
          "--deplo-robot-ink": `oklch(var(--deplo-robot-l) var(--deplo-robot-c) ${accent.hue})`,
          "--deplo-robot-live": "var(--deplo-robot-ink)",
        } as React.CSSProperties)
      : undefined;
  const lit = live ? LIVE : INK;
  const shell = { ...plain, stroke: INK };
  const hand = cable ? REACH_HAND : REST_HAND;

  return (
    <IsoArt
      label={LABEL[state]}
      view={fit([
        FLOOR,
        DEPLO_BOX,
        { at: [CX - 0.6, CY - 0.6, 0], size: [1.2, 1.2, ANTENNA_TOP + 0.2] },
      ])}
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

      <Disc
        at={[CX, CY, 0]}
        r={0.42}
        fill="var(--border)"
        stroke="none"
        className={cn(floating && "iso-robot-shadow")}
      />

      {cable && (
        <g stroke={INK} strokeWidth="2.5">
          <Path
            points={[REACH_HAND, CORNER]}
            className={cn(!live && "iso-robot-cable-a")}
          />
          <Path
            points={[CORNER, PORT]}
            className={cn(!live && "iso-robot-cable-b")}
          />
        </g>
      )}

      <g className={cn(floating && "iso-robot-float")}>
        <Cylinder at={[CX, CY, BODY.z]} r={BODY.r} h={BODY.h} tone={shell}>
          <Facing at={onSurface(BODY.r, BODY.z + BODY.h / 2)} deg={TURN}>
            {live ? (
              <path
                d="M0 6l-6 -6a3.5 3.5 0 0 1 6 -4a3.5 3.5 0 0 1 6 4z"
                fill={lit}
                stroke="none"
                className="iso-robot-beat"
              />
            ) : (
              <circle
                r={4}
                fill={lit}
                stroke="none"
                className={cn(state === "key" && "iso-blink")}
              />
            )}
          </Facing>
        </Cylinder>
        <Cylinder at={[CX, CY, HEAD.z]} r={HEAD.r} h={HEAD.h} tone={shell}>
          <Facing at={onSurface(HEAD.r, HEAD.z + HEAD.h / 2)} deg={TURN}>
            <Face state={state} lit={lit} />
          </Facing>
        </Cylinder>
        <Dome fill={shell.top} />
        <Path
          points={[
            [CX, CY, HEAD.z + HEAD.h + DOME],
            [CX, CY, ANTENNA_TOP],
          ]}
          stroke={INK}
          strokeWidth="2"
        />
        <g
          className={cn(
            state === "idle" && "iso-robot-antenna",
            state === "key" && "iso-robot-blip",
          )}
        >
          <Sphere at={[CX, CY, ANTENNA_TOP + 0.08]} r={6} fill={lit} />
        </g>
        <Sphere at={NEAR_HAND} r={8} fill="var(--iso-top)" />
        <g className={cn(state === "idle" && "iso-robot-wave")}>
          <Sphere at={hand} r={8} fill="var(--iso-top)" />
          {state === "key" && (
            <Facing at={[hand[0] + 0.12, hand[1], hand[2]]} deg={90}>
              <g
                stroke={INK}
                strokeWidth="2.5"
                strokeLinecap="round"
                className="iso-robot-key"
              >
                <circle cx={7} cy={0} r={7} />
                <path d="M14 0h18M26 0v8" />
              </g>
            </Facing>
          )}
        </g>
      </g>
    </IsoArt>
  );
}
