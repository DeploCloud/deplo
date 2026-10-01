import {
  Box,
  Decal,
  IsoArt,
  UNIT,
  fit,
  floor,
  shade,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const H = 1.3;
const PASSWORD: BoxShape = { at: [0, 0, 0], size: [1.6, 0.3, H] };
const PRINT: BoxShape = { at: [1.6, -1.6, 0], size: [1.6, 0.3, H] };
const SHIELD_AT: P = [3.25, -3.05, H];
const DEPTH = 8;

const u = (n: number) => n * UNIT;

/** A glyph standing in the gap between two pieces, in the faces' plane. */
function Glyph({ at, d }: { at: P; d: string }) {
  return (
    <Decal face="left" at={at}>
      <path
        d={d}
        className="stroke-ring"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Decal>
  );
}

export function TwoFactorGraphic({ className }: { className?: string }) {
  const shield = `M${u(0.55)} 0L${u(1.1)} ${u(0.18)}V${u(0.62)}C${u(1.1)} ${u(0.95)} ${u(0.82)} ${u(1.15)} ${u(0.55)} ${u(1.27)}C${u(0.28)} ${u(1.15)} 0 ${u(0.95)} 0 ${u(0.62)}V${u(0.18)}Z`;
  return (
    <IsoArt
      label="A password field and a fingerprint, approved by a shield"
      view={fit(
        [
          PASSWORD,
          PRINT,
          { at: [-0.3, -0.3, 0], size: [2, 0.9, 0] },
          { at: [3.0, -3.5, 0], size: [1.4, 0.9, H + 0.2] },
        ],
        6,
      )}
      className={cn("h-full w-full", className)}
    >
      <Box at={[-0.3, -0.3, 0]} size={[2.2, 0.9, 0]} tone={floor} />
      <Box at={[1.3, -1.9, 0]} size={[2.2, 0.9, 0]} tone={floor} />
      <Box at={[2.9, -3.5, 0]} size={[2.2, 0.9, 0]} tone={floor} />

      <Box {...PASSWORD}>
        <Decal face="left" at={[0, 0.3, H]} style={{ stroke: "none" }}>
          {[0.32, 0.64, 0.96, 1.28].map((x) => (
            <circle
              key={x}
              cx={u(x)}
              cy={u(H / 2)}
              r={u(0.09)}
              className="fill-muted-foreground"
            />
          ))}
        </Decal>
      </Box>

      <Glyph
        at={[1.62, -0.55, 0.85]}
        d={`M0 ${u(0.2)}h${u(0.4)}M${u(0.2)} 0v${u(0.4)}`}
      />

      <Box {...PRINT}>
        <Decal face="left" at={[1.6, -1.3, H]}>
          <g
            stroke="var(--chart-1)"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          >
            {[0.5, 0.36, 0.22, 0.09].map((r) => (
              <path
                key={r}
                d={`M${u(0.8 - r)} ${u(1.02)}V${u(0.72)}a${u(r)} ${u(r * 1.05)} 0 0 1 ${u(2 * r)} 0V${u(1.02)}`}
              />
            ))}
          </g>
        </Decal>
      </Box>

      <Glyph
        at={[3.08, -2.05, 0.85]}
        d={`M0 0L${u(0.22)} ${u(0.2)}L0 ${u(0.4)}`}
      />

      {/* An extruded shield: the back copies step toward -y, then the face. */}
      {Array.from({ length: DEPTH }, (_, i) => {
        const back = 0.3 * (1 - i / DEPTH);
        return (
          <Decal
            key={i}
            face="left"
            at={[SHIELD_AT[0], SHIELD_AT[1] - back, SHIELD_AT[2]]}
          >
            <path d={shield} fill={shade("var(--success)", "right")} />
          </Decal>
        );
      })}
      <Decal face="left" at={SHIELD_AT}>
        <path
          d={shield}
          fill={shade("var(--success)")}
          stroke="var(--success)"
          strokeWidth="1.5"
        />
        <path
          d={`M${u(0.3)} ${u(0.62)}l${u(0.17)} ${u(0.17)}l${u(0.33)} ${u(-0.33)}`}
          stroke="var(--success)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Decal>
    </IsoArt>
  );
}
