import {
  Box,
  FaceRect,
  IsoArt,
  Path,
  fit,
  floor,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [2.4, 2.4, 0] };
const SOCKET: BoxShape = { at: [0.7, 0.7, 0], size: [1, 1, 0.35] };
const PLUG: BoxShape = { at: [0.85, 0.85, 1.35], size: [0.7, 0.7, 0.55] };
const PINS = [0.98, 1.36];

export function NotRunningGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A plug hanging unplugged above its socket"
      view={fit([FLOOR, { at: [0.85, 0.85, 1.35], size: [0.7, 0.7, 1.4] }])}
      // The cord comes down from above the frame, so the drawing clips it.
      className={cn("size-32 overflow-hidden", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Box {...SOCKET}>
        {PINS.map((x) => (
          <FaceRect
            key={x}
            box={SOCKET}
            face="top"
            u={[x - 0.7, x - 0.62]}
            v={[0.38, 0.62]}
            fill="none"
            className="fill-ring dark:fill-background"
          />
        ))}
      </Box>

      <g className="iso-plug-sway">
        <g className="iso-plug-dip">
          <Path
            points={[
              [1.2, 1.2, 1.9],
              [1.2, 1.2, 5],
            ]}
            className="stroke-muted-foreground"
            strokeWidth="3"
          />
          {PINS.map((x) => (
            <Box
              key={x}
              at={[x, 1.09, 1.05]}
              size={[0.08, 0.22, 0.3]}
              tone={tone("var(--warning)")}
            />
          ))}
          <Box {...PLUG} tone={tone("var(--violet)")}>
            {[0.3, 0.5, 0.7].map((u) => (
              <FaceRect
                key={u}
                box={PLUG}
                face="left"
                u={[u - 0.03, u + 0.03]}
                v={[0.25, 0.75]}
                fill="var(--violet)"
              />
            ))}
          </Box>
        </g>
      </g>
    </IsoArt>
  );
}
