import type * as React from "react";
import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  IsoGrid,
  Path,
  Ring,
  UNIT,
  fit,
  floor,
  tone,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { DEPLO, Mark } from "@/components/iso/parts";
import { cn } from "@/lib/utils";
import {
  markPaths,
  SOURCE_ART,
  PICKABLE_KINDS,
  SOURCE_COPY,
  SWAP_HALF_MS,
  type SourceKind,
} from "./sources";

export type MigrationState =
  "connect" | "install" | "review" | "moving" | "done";

function graphicLabel(state: MigrationState, kind: SourceKind | null): string {
  if (!kind)
    return "A Dokploy or a Coolify server and a Deplo server, not yet linked";
  const n = kind === "deplo" ? "old Deplo" : SOURCE_COPY[kind].name;
  switch (state) {
    case "connect":
      return `The ${n} server and a Deplo server, not yet linked`;
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
const SOURCE: BoxShape = { at: [0, 3, 0], size: [2, 2, 2] };
const TARGET: BoxShape = { at: [3, 0, 0], size: [2, 2, 2] };
// Out of the source's side, round the corner, into Deplo's front.
const CABLE: P[] = [
  [2, 4, 0],
  [4, 4, 0],
  [4, 2, 0],
];
const MARK = 0.8;

export function MigrationGraphic({
  state = "connect",
  kind = null,
  grid = false,
  className,
}: {
  state?: MigrationState;
  kind?: SourceKind | null;
  grid?: boolean;
  className?: string;
}) {
  const done = state === "done";
  const moving = state === "moving";
  const cable = done ? "var(--success)" : "var(--info)";
  return (
    <IsoArt
      label={graphicLabel(state, kind)}
      view={fit([SOURCE, TARGET, { at: [0, 0, 0], size: [4.3, 4.3, 0] }])}
      className={cn("h-32 w-auto", className)}
    >
      {grid && <IsoGrid at={[2.5, 2.5, 0]} radius={380} />}
      <Box at={[-0.3, 2.7, 0]} size={[2.6, 2.6, 0]} tone={floor} />
      <Box at={[2.7, -0.3, 0]} size={[2.6, 2.6, 0]} tone={floor} />

      <Machine box={SOURCE} lit={!done}>
        <Decal face="left" at={[1 - MARK / 2, 5, 1.25 + MARK / 2]}>
          {kind ? (
            <SourceFace
              key={kind}
              kind={kind}
              dim={done}
              className={cn(
                "iso-migration-mark",
                done ? "text-border" : "text-foreground",
              )}
            />
          ) : (
            PICKABLE_KINDS.map((k, i) => (
              <SourceFace
                key={k}
                kind={k}
                className="iso-migration-swap text-foreground"
                style={{ animationDelay: `${-i * SWAP_HALF_MS}ms` }}
              />
            ))
          )}
        </Decal>
      </Machine>

      <Machine box={TARGET} tone={DEPLO} lit={done}>
        <Mark at={[4 - MARK / 2, 2, 1.25 + MARK / 2]} size={MARK} />
      </Machine>
      {done && (
        <Ring
          at={[3, 0, 2]}
          size={[2, 2, 0]}
          color="var(--success)"
          className="iso-wave"
          style={{ "--iso-dur": "2.6s" } as React.CSSProperties}
        />
      )}

      <Path
        points={CABLE}
        className={cn("stroke-ring", !done && "iso-march")}
        strokeWidth="1.5"
        strokeDasharray="2 6"
      />
      <Path
        points={CABLE}
        pathLength={1}
        strokeDasharray="1 1"
        strokeDashoffset={CABLE_LEFT[state]}
        stroke={cable}
        strokeWidth="2"
        className="iso-migration-cable"
      />
      {moving &&
        Array.from({ length: PACKETS }, (_, i) => (
          <g
            key={i}
            className="iso-migration-packet"
            style={{ animationDelay: `${i * 0.6}s` }}
          >
            <Box
              at={[1.85, 3.85, 0]}
              size={[0.3, 0.3, 0.3]}
              tone={tone("var(--warning)")}
            />
          </g>
        ))}

      <FaceRect
        box={SOURCE}
        face="right"
        u={[0.4, 0.6]}
        v={[0.03, 0.15]}
        fill={done ? "var(--success)" : "var(--iso-left)"}
        stroke="var(--ring)"
      />
      <FaceRect
        box={TARGET}
        face="left"
        u={[0.4, 0.6]}
        v={[0.03, 0.15]}
        fill={cable}
        stroke={DEPLO.stroke}
      />
    </IsoArt>
  );
}

/** A server: its face on top, a status light and a slot below it. */
function Machine({
  box,
  tone: t,
  lit,
  children,
}: {
  box: BoxShape;
  tone?: typeof DEPLO;
  lit: boolean;
  children: React.ReactNode;
}) {
  const brand = t === DEPLO;
  return (
    <Box {...box} tone={t}>
      {children}
      <FaceRect
        box={box}
        face="left"
        u={[0.12, 0.2]}
        v={[0.36, 0.44]}
        fill={lit ? "var(--success)" : brand ? DEPLO.stroke : "var(--border)"}
        className={lit && !brand ? "iso-blink" : undefined}
      />
      <FaceRect
        box={box}
        face="left"
        u={[0.3, 0.88]}
        v={[0.38, 0.42]}
        fill={brand ? DEPLO.stroke : "var(--border)"}
      />
    </Box>
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
  const side = MARK * UNIT;
  return (
    <g className={className} style={style} stroke="none">
      <svg width={side} height={side} viewBox={SOURCE_ART[kind].viewBox}>
        {markPaths(SOURCE_ART[kind], dim)}
      </svg>
    </g>
  );
}
