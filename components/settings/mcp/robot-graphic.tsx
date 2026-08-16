import { cn } from "@/lib/utils";

/**
 * The connect wizard's illustration: a robot, a cable, and deplo.
 *
 * One drawing in four poses rather than four drawings, because the pose IS the
 * progress bar. A stepper says "2 of 4"; a robot holding a key says what step
 * two is for. The four are the four questions the wizard asks in order — may an
 * agent in here, which agent, what may it do, and is it actually talking to us —
 * so a reader who glances at the picture instead of the heading still knows
 * where they are.
 *
 * - `idle`     — looking around, arm empty. Nothing chosen yet.
 * - `key`      — holding a credential. The permissions step.
 * - `reaching` — the cable stretches toward deplo and falls short, over and
 *                over. The config has been copied and nothing has called yet.
 * - `connected`— cable landed, port lit, eyes green. A real request arrived.
 *
 * Pure SVG plus keyframes in `globals.css`, like the other eighteen graphics
 * here: no library, no JS, correct in both themes because every colour is a
 * token, and a server component because there is nothing to hydrate. Under
 * `prefers-reduced-motion` each pose holds its finished frame instead of
 * vanishing — the reaching cable rests fully drawn, which is the frame that
 * still says "this cable goes there".
 *
 * The `aria-label` changes with the pose. It is the entire drawing for anyone
 * who cannot see it, so it describes the state and not the artwork.
 */

const LABEL: Record<RobotState, string> = {
  idle: "A robot waiting to be connected to deplo",
  key: "A robot holding a key, ready to be given permissions",
  reaching: "A robot reaching a cable toward deplo",
  connected: "A robot plugged into deplo",
};

export type RobotState = "idle" | "key" | "reaching" | "connected";

export function RobotGraphic({
  state = "idle",
  className,
}: {
  state?: RobotState;
  className?: string;
}) {
  const live = state === "connected";
  return (
    <svg
      viewBox="0 0 160 120"
      fill="none"
      role="img"
      aria-label={LABEL[state]}
      className={cn("h-32 w-auto", className)}
    >
      {/* ---- deplo, on the right. Recessive: it is already there, and the
              robot arriving is the subject. ---- */}
      <rect
        x="118"
        y="40"
        width="32"
        height="48"
        rx="6"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
      />
      <line
        x1="125"
        y1="51"
        x2="143"
        y2="51"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <line
        x1="125"
        y1="60"
        x2="143"
        y2="60"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The port the cable is aiming at. The one element that turns green, and
          only on `connected` — the single success beat the sibling graphics
          each spend their one `--success` on. */}
      {live && (
        <circle
          cx="116"
          cy="72"
          r="10"
          className="deplo-robot-halo"
          fill="var(--success)"
        />
      )}
      <rect
        x="112"
        y="67"
        width="7"
        height="10"
        rx="2"
        className={live ? undefined : "stroke-muted-foreground/40"}
        fill={live ? "var(--success)" : "none"}
        strokeWidth="2.5"
      />

      {/* ---- the cable. Absent until there is something to connect. ---- */}
      {(state === "reaching" || live) && (
        <path
          d="M74 74 C90 76, 96 72, 112 72"
          className={
            live
              ? "stroke-primary"
              : "deplo-robot-cable stroke-muted-foreground/70"
          }
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      )}

      {/* ---- the key, only while permissions are being chosen ---- */}
      {state === "key" && (
        <g className="deplo-robot-key stroke-primary" strokeWidth="2.5">
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
        className="stroke-muted-foreground/60"
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
          live ? "fill-[var(--success)]" : "fill-primary",
        )}
      />
      <rect
        x="24"
        y="26"
        width="40"
        height="32"
        rx="11"
        className="stroke-primary"
        strokeWidth="2.5"
      />
      <g
        className={cn(
          state === "idle" && "deplo-robot-eyes",
          live ? "fill-[var(--success)]" : "fill-primary",
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
        className="stroke-primary"
        strokeWidth="2.5"
      />
      <rect
        x="28"
        y="63"
        width="32"
        height="29"
        rx="8"
        className="stroke-primary"
        strokeWidth="2.5"
      />
      <path
        d="M60 71 L74 74"
        className="stroke-primary"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** How many pieces the burst throws. Twelve reads as a burst; thirty reads as weather. */
const CONFETTI = 12;

/**
 * The one-shot celebration for a connection that actually happened.
 *
 * Deliberately CSS and not a library: this is a 1.1s burst of twelve spans, and
 * pulling in a canvas confetti package for it would put a second animation
 * grammar in a repo that has exactly one. Each piece takes its angle, distance,
 * delay and colour from an `--i` index, so the whole thing is one keyframe.
 *
 * It renders nothing under `prefers-reduced-motion`: confetti is pure
 * decoration, and a person who asked for less motion is not owed a still frame
 * of it. Mount it only when the success arrives — it has no state and replays
 * by being remounted, which is what a `key` on the parent does for free.
 */
export function ConfettiBurst({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute left-1/2 top-1/2 size-0 motion-reduce:hidden",
        className,
      )}
    >
      {Array.from({ length: CONFETTI }, (_, i) => (
        <span
          key={i}
          className="deplo-confetti-piece"
          style={{ "--i": i } as React.CSSProperties}
        />
      ))}
    </span>
  );
}
