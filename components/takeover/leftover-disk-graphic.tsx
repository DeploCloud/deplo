import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  IsoGrid,
  fit,
  floor,
  ghost,
  tone,
  wire,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const DISK: BoxShape = { at: [0, 0, 0], size: [6, 2, 0.6] };
const PANEL: BoxShape = { at: [0.4, 0.5, 0.95], size: [1.6, 1, 1.1] };
const SLOTS = 6;
const TAKEN = 4;

// Widened to the slot's old proportions, so the wizard keeps its height.
function wide(view: string, ratio: number) {
  const [x, y, w, h] = view.split(" ").map(Number);
  const grow = Math.max(0, h * ratio - w) / 2;
  return `${x - grow} ${y} ${w + 2 * grow} ${h}`;
}

export function LeftoverDiskGraphic({
  grid = false,
  className,
}: {
  grid?: boolean;
  className?: string;
}) {
  return (
    <IsoArt
      label="A disk with the stopped platform still taking up part of it"
      view={wide(fit([{ at: [-0.3, -0.3, 0], size: [6.6, 2.6, 2.05] }]), 1.85)}
      className={cn("h-auto w-full", className)}
    >
      {grid ? (
        // The grid is the floor here: the disk stands on its whole steps.
        <IsoGrid at={[3, 1, 0]} radius={520} />
      ) : (
        <Box at={[-0.3, -0.3, 0]} size={[6.6, 2.6, 0]} tone={floor} />
      )}
      <Box {...DISK}>
        <FaceRect
          box={DISK}
          face="left"
          u={[0.03, 0.06]}
          v={[0.35, 0.65]}
          fill="var(--success)"
        />
        <FaceRect
          box={DISK}
          face="left"
          u={[0.7, 0.95]}
          v={[0.42, 0.58]}
          fill="var(--border)"
        />
      </Box>

      {Array.from({ length: SLOTS }, (_, i) => {
        const slot: BoxShape = {
          at: [i + 0.1, 0.3, 0.6],
          size: [0.8, 1.4, 0.35],
        };
        return i < TAKEN ? (
          <Box
            key={i}
            {...slot}
            tone={tone("var(--warning)")}
            className="iso-disk-share"
            style={{ animationDelay: `${0.15 + i * 0.12}s` }}
          />
        ) : (
          <Box key={i} {...slot} tone={ghost} className={wire} />
        );
      })}

      <Box {...PANEL} className="iso-disk-panel">
        <Decal face="left" at={[0.965, 1.5, 1.84]}>
          <g fill="var(--warning)" stroke="none">
            <rect x="0" y="0" width="9" height="38" rx="2" />
            <rect x="17" y="0" width="9" height="38" rx="2" />
          </g>
        </Decal>
        <FaceRect
          box={PANEL}
          face="left"
          u={[0.08, 0.92]}
          v={[0.14, 0.22]}
          fill="var(--border)"
        />
        <FaceRect
          box={PANEL}
          face="right"
          u={[0.2, 0.8]}
          v={[0.6, 0.68]}
          fill="var(--border)"
        />
      </Box>
    </IsoArt>
  );
}
