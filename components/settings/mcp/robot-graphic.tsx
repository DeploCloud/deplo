import type * as React from "react";
import { cn } from "@/lib/utils";
import type { LogoAccent } from "@/lib/templates/logo-color";

/** The connect wizard's illustration: a robot, a cable, and Deplo. */

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
  // An agent with a hue spends it on the success beat too: green next to orange
  // reads as a second, unrelated colour.
  const ink =
    accent?.hue !== undefined
      ? ({
          "--deplo-robot-ink": `oklch(var(--deplo-robot-l) var(--deplo-robot-c) ${accent.hue})`,
          "--deplo-robot-live": "var(--deplo-robot-ink)",
        } as React.CSSProperties)
      : undefined;
  return (
    <svg
      viewBox="0 0 160 120"
      fill="none"
      role="img"
      aria-label={LABEL[state]}
      style={ink}
      className={cn("h-32 w-auto", className)}
    >
      {/* ---- Deplo, on the right. Recessive: it is already there, and the
              robot arriving is the subject. ---- */}
      <rect
        x="118"
        y="40"
        width="32"
        height="48"
        rx="6"
        className="stroke-ring"
        strokeWidth="2.5"
      />
      <line
        x1="125"
        y1="51"
        x2="143"
        y2="51"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <line
        x1="125"
        y1="60"
        x2="143"
        y2="60"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The port the cable is aiming at. The one element that lights up, and
          only on `connected` - the single success beat, drawn in the agent's own
          colour when it has one. */}
      {live && (
        <circle
          cx="116"
          cy="72"
          r="10"
          className="deplo-robot-halo"
          fill="var(--deplo-robot-live)"
        />
      )}
      <rect
        x="112"
        y="67"
        width="7"
        height="10"
        rx="2"
        className={live ? undefined : "stroke-ring"}
        fill={live ? "var(--deplo-robot-live)" : "none"}
        strokeWidth="2.5"
      />

      {/* ---- the cable. Absent until there is something to connect, and in the
              robot's own ink: it continues the arm, so a second colour here
              reads as one line painted half-way. ---- */}
      {(state === "reaching" || live) && (
        <path
          d="M74 74 C90 76, 96 72, 112 72"
          className={cn(
            !live && "deplo-robot-cable",
            "stroke-[var(--deplo-robot-ink)]",
          )}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      )}

      {/* ---- the key, only while permissions are being chosen ---- */}
      {state === "key" && (
        <g
          className="deplo-robot-key stroke-[var(--deplo-robot-ink)]"
          strokeWidth="2.5"
        >
          <circle cx="76" cy="72" r="4.5" />
          <line x1="80" y1="72" x2="90" y2="72" strokeLinecap="round" />
          <line x1="86" y1="72" x2="86" y2="77" strokeLinecap="round" />
        </g>
      )}

      {/* ---- the robot ---- */}
      <line
        x1="44"
        y1="26"
        x2="44"
        y2="17"
        className="stroke-ring"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle
        cx="44"
        cy="14"
        r="3.5"
        className={cn(
          state === "idle" && "deplo-robot-antenna",
          state === "key" && "deplo-robot-blip",
          live
            ? "fill-[var(--deplo-robot-live)]"
            : "fill-[var(--deplo-robot-ink)]",
        )}
      />
      <rect
        x="24"
        y="26"
        width="40"
        height="32"
        rx="11"
        className="stroke-[var(--deplo-robot-ink)]"
        strokeWidth="2.5"
      />
      <g
        className={cn(
          state === "idle" && "deplo-robot-eyes",
          live
            ? "fill-[var(--deplo-robot-live)]"
            : "fill-[var(--deplo-robot-ink)]",
        )}
      >
        <circle cx="36" cy="42" r="3.5" />
        <circle cx="52" cy="42" r="3.5" />
      </g>
      {/* Neck, torso, arm. All one weight so the robot reads as one object. */}
      <line
        x1="44"
        y1="58"
        x2="44"
        y2="63"
        className="stroke-[var(--deplo-robot-ink)]"
        strokeWidth="2.5"
      />
      <rect
        x="28"
        y="63"
        width="32"
        height="29"
        rx="8"
        className="stroke-[var(--deplo-robot-ink)]"
        strokeWidth="2.5"
      />
      <path
        d="M60 71 L74 74"
        className="stroke-[var(--deplo-robot-ink)]"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
