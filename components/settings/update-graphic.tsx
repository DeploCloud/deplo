import {
  Box,
  Disc,
  FaceRect,
  IsoArt,
  Legs,
  Path,
  fit,
  floor,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { DeploCube } from "@/components/iso/parts";
import { cn } from "@/lib/utils";

const SLAB: BoxShape = { at: [0, 0, 0], size: [3, 2.6, 0] };
const LATEST = tone("var(--success)");
const HEIGHTS = [2.2, 1.6, 1];

export function UpdateGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A timeline of Deplo releases, with the one this instance runs marked"
      view={fit(
        [
          SLAB,
          { at: [0, 0, -0.6], size: [3, 2.6, 2.8] },
          { at: [2.2, 0.7, 1.25], size: [0.6, 0.6, 0.9] },
        ],
        8,
      )}
      className={cn("h-auto w-full", className)}
    >
      <Legs at={SLAB.at} size={SLAB.size} drop={0.6} />
      <Box {...SLAB} tone={floor} />
      <Path
        points={[
          [0, 2.3, 0],
          [3, 2.3, 0],
        ]}
        className="stroke-ring"
        strokeWidth="1.5"
        strokeDasharray="4 4"
      />

      {HEIGHTS.map((h, i) => {
        const box: BoxShape = { at: [i, 0, 0], size: [1, 2, h] };
        const latest = i === 0;
        const top = (n: number) => 1 - n / h;
        return (
          <g key={h}>
            <Disc
              at={[i + 0.5, 2.3, 0]}
              r={0.1}
              fill={latest ? "var(--success)" : "var(--ring)"}
              stroke="none"
            />
            <Box {...box} tone={latest ? LATEST : undefined}>
              <FaceRect
                box={box}
                face="left"
                u={[0.15, 0.55]}
                v={[top(0.42), top(0.26)]}
                fill={latest ? "var(--success)" : "var(--muted-foreground)"}
                className={latest ? "iso-blink" : undefined}
              />
              <FaceRect
                box={box}
                face="left"
                u={[0.15, 0.85]}
                v={[top(0.6), top(0.54)]}
                fill={latest ? "var(--success)" : "var(--ring)"}
              />
              <FaceRect
                box={box}
                face="right"
                u={[0.12, 0.88]}
                v={[top(0.42), top(0.36)]}
                fill={latest ? "var(--success)" : "var(--ring)"}
              />
            </Box>
          </g>
        );
      })}

      <g className="iso-bob">
        <DeploCube at={[2.2, 0.7, 1.25]} size={0.6} />
      </g>
    </IsoArt>
  );
}
