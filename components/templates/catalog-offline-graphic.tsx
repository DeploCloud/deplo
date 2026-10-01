import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  Path,
  fit,
  floor,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { Rack } from "@/components/iso/parts";
import { cn } from "@/lib/utils";

const INSTANCE: BoxShape = { at: [0, 0, 0], size: [2, 2, 1] };
const CATALOG: BoxShape = { at: [0, 0, 4], size: [2, 2, 0.5] };
const BREAK = 2.6;
const TILES = [1, 2, 3, 4].map((n, i) => ({
  color: `var(--chart-${n})`,
  u: [0.12 + (i % 2) * 0.44, 0.44 + (i % 2) * 0.44] as [number, number],
  v: [0.12 + Math.floor(i / 2) * 0.44, 0.44 + Math.floor(i / 2) * 0.44] as [
    number,
    number,
  ],
}));

export function CatalogOfflineGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A request rising from this instance toward the template catalog and stopping at a broken connection"
      view={fit([{ at: [-0.5, -0.5, 0], size: [3, 3, 4.5] }])}
      className={cn("size-32", className)}
    >
      <Box at={[-0.5, -0.5, 0]} size={[3, 3, 0]} tone={floor} />
      <Rack box={INSTANCE} />

      <g className="stroke-ring" strokeWidth="1.5" strokeDasharray="4 4">
        <Path
          points={[
            [1, 1, 1],
            [1, 1, BREAK - 0.3],
          ]}
        />
        <Path
          points={[
            [1, 1, BREAK + 0.3],
            [1, 1, 4],
          ]}
        />
      </g>

      <g className="iso-offline-packet">
        <Box
          at={[0.85, 0.85, BREAK - 0.7]}
          size={[0.3, 0.3, 0.3]}
          tone={tone("var(--warning)")}
        />
      </g>

      <Decal face="left" at={[1, 1, BREAK]}>
        <g
          className="iso-offline-break stroke-destructive"
          strokeWidth="3"
          strokeLinecap="round"
        >
          <path d="M-11 -11L11 11M11 -11L-11 11" />
        </g>
      </Decal>

      <g className="iso-offline-catalog">
        <Box {...CATALOG}>
          {TILES.map((t) => (
            <FaceRect
              key={t.color}
              box={CATALOG}
              face="top"
              u={t.u}
              v={t.v}
              fill={t.color}
            />
          ))}
          <FaceRect
            box={CATALOG}
            face="left"
            u={[0.08, 0.16]}
            v={[0.35, 0.65]}
            fill="var(--ring)"
          />
          <FaceRect
            box={CATALOG}
            face="left"
            u={[0.5, 0.9]}
            v={[0.44, 0.56]}
            fill="var(--border)"
          />
        </Box>
      </g>
    </IsoArt>
  );
}
