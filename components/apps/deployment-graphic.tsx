import {
  Box,
  IsoArt,
  Path,
  Ring,
  Tick,
  fit,
  floor,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { Rack } from "@/components/iso/parts";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [0, 0, 0], size: [5, 2, 0] };
const BELT: BoxShape = { at: [0, 0.5, 0], size: [3, 1, 0.25] };
const SERVER: BoxShape = { at: [3, 0, 0], size: [2, 2, 3] };

export function DeploymentGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A crate riding a conveyor into a server, which lights up and goes live"
      view={fit([BELT, SERVER, { at: [0, 0.5, 1], size: [1, 1, 1] }])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Box {...BELT} />
      <Path
        points={[
          [0, 1, 0.25],
          [3, 1, 0.25],
        ]}
        className="stroke-ring"
        strokeWidth="1"
        strokeDasharray="4 4"
      />

      <g className="iso-deploy-crate">
        <Box
          at={[0.15, 0.65, 0.25]}
          size={[0.7, 0.7, 0.7]}
          tone={tone("var(--warning)")}
        />
      </g>

      <Rack
        box={SERVER}
        led={(i) => ({
          fill: "var(--success)",
          className: "iso-deploy-bay",
          style: { animationDelay: `${i * 0.3}s` },
        })}
      />
      <Ring
        at={[3, 0, 3]}
        size={[2, 2, 0]}
        color="var(--success)"
        className="iso-deploy-live"
      />

      <Tick at={[5, 2, 0]} />
      <Tick at={[3, 0, 3]} />
    </IsoArt>
  );
}
