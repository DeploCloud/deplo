import * as React from "react";
import { cn } from "@/lib/utils";
import { MARK_PATH, MARK_VIEWBOX } from "@/components/logo";
import {
  markPaths,
  SOURCE_ART,
  SOURCE_COPY,
  SOURCE_KINDS,
  SWAP_HALF_MS,
  type SourceKind,
} from "./sources";

export type MigrationState =
  "connect" | "install" | "review" | "moving" | "done";

function graphicLabel(state: MigrationState, kind: SourceKind | null): string {
  if (!kind)
    return "A Dokploy or a Coolify server and a Deplo server, not yet linked";
  const n = SOURCE_COPY[kind].name;
  switch (state) {
    case "connect":
      return `A ${n} server and a Deplo server, not yet linked`;
    case "install":
      return `A cable being run from the ${n} server toward Deplo`;
    case "review":
      return `The cable from ${n} to Deplo, nearly complete`;
    case "moving":
      return `Data travelling along the cable from ${n} to Deplo`;
    case "done":
      return `The Deplo server lit up, the ${n} server switched off`;
  }
}

const CABLE_LEFT: Record<MigrationState, number> = {
  connect: 0.8,
  install: 0.6,
  review: 0.4,
  moving: 0,
  done: 0,
};

const PACKETS = 3;

const BRAND_GRADIENT = "deplo-migration-brand";

export function MigrationGraphic({
  state = "connect",
  kind = null,
  className,
}: {
  state?: MigrationState;
  kind?: SourceKind | null;
  className?: string;
}) {
  const done = state === "done";
  const moving = state === "moving";
  return (
    <svg
      viewBox="-10 18 180 84"
      fill="none"
      role="img"
      aria-label={graphicLabel(state, kind)}
      className={cn("h-32 w-auto", className)}
    >
      <defs>
        <linearGradient
          id={BRAND_GRADIENT}
          gradientUnits="userSpaceOnUse"
          x1="112"
          y1="32"
          x2="156"
          y2="88"
        >
          <stop offset="0%" stopColor="var(--deplo-migrate-g1)" />
          <stop offset="50%" stopColor="var(--deplo-migrate-g2)" />
          <stop offset="100%" stopColor="var(--deplo-migrate-g3)" />
        </linearGradient>
      </defs>

      <Machine x={4} dim={done}>
        {kind ? (
          <SourceFace
            key={kind}
            kind={kind}
            dim={done}
            className={cn(
              "deplo-migrate-mark",
              done ? "text-border" : "text-foreground",
            )}
          />
        ) : (
          SOURCE_KINDS.map((k, i) => (
            <SourceFace
              key={k}
              kind={k}
              className="deplo-migrate-swap text-foreground"
              style={{ animationDelay: `${-i * SWAP_HALF_MS}ms` }}
            />
          ))
        )}
      </Machine>

      <path
        d="M52 60 H108"
        className={cn("stroke-border", !done && "deplo-migrate-track")}
        strokeWidth="2.5"
        strokeDasharray="2 4"
        strokeLinecap="round"
      />
      <path
        d="M52 60 H108"
        pathLength="1"
        strokeDasharray="1 1"
        strokeDashoffset={CABLE_LEFT[state]}
        className={cn(
          "deplo-migrate-cable",
          done ? "stroke-[var(--success)]" : "stroke-primary",
        )}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {moving &&
        Array.from({ length: PACKETS }, (_, i) => (
          <circle
            key={i}
            cx="54"
            cy="60"
            r="2.5"
            className="deplo-migrate-packet fill-primary"
            style={{ "--i": i } as React.CSSProperties}
          />
        ))}

      <Socket x={44} lit={done} />
      <Socket x={108} brand />

      {done && (
        <circle
          cx="134"
          cy="60"
          r="34"
          className="deplo-migrate-halo"
          fill={`url(#${BRAND_GRADIENT})`}
        />
      )}
      <Machine x={112} brand>
        <svg
          x="125"
          y="41"
          width="18"
          height="18"
          viewBox={MARK_VIEWBOX}
          className="text-foreground"
        >
          <path d={MARK_PATH} fill="currentColor" />
        </svg>
      </Machine>
    </svg>
  );
}

function SourceFace({
  kind,
  dim = false,
  className,
  style,
}: {
  kind: SourceKind;
  dim?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <g className={className} style={style}>
      <svg
        x="16"
        y="42"
        width="18"
        height="18"
        viewBox={SOURCE_ART[kind].viewBox}
      >
        {markPaths(SOURCE_ART[kind], dim)}
      </svg>
    </g>
  );
}

function Machine({
  x,
  dim,
  brand,
  children,
}: {
  x: number;
  dim?: boolean;
  brand?: boolean;
  children: React.ReactNode;
}) {
  const ink = brand ? `url(#${BRAND_GRADIENT})` : undefined;
  const line = dim ? "stroke-border" : "stroke-ring";
  return (
    <>
      <rect
        x={x}
        y="32"
        width="44"
        height="56"
        rx="7"
        stroke={ink}
        className={
          brand ? undefined : dim ? "stroke-border" : "stroke-muted-foreground"
        }
        strokeWidth="2.5"
      />
      {children}
      {[70, 79].map((y, i) => (
        <React.Fragment key={y}>
          <line
            x1={x + 9}
            y1={y}
            x2={x + 27}
            y2={y}
            stroke={ink}
            className={brand ? "opacity-70" : line}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <circle
            cx={x + 34}
            cy={y}
            r="2"
            fill={ink}
            className={cn(
              i === 0 && !dim && !brand && "deplo-migrate-blip",
              brand
                ? i === 0
                  ? undefined
                  : "opacity-50"
                : dim
                  ? "fill-border"
                  : i === 0
                    ? "fill-muted-foreground"
                    : "fill-ring",
            )}
          />
        </React.Fragment>
      ))}
    </>
  );
}

function Socket({
  x,
  lit,
  brand,
}: {
  x: number;
  lit?: boolean;
  brand?: boolean;
}) {
  return (
    <rect
      x={x}
      y="56"
      width="8"
      height="8"
      rx="2"
      stroke={brand ? `url(#${BRAND_GRADIENT})` : undefined}
      className={
        brand ? undefined : lit ? "stroke-[var(--success)]" : "stroke-ring"
      }
      fill="var(--background)"
      strokeWidth="2.5"
    />
  );
}
