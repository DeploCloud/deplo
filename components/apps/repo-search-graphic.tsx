import {
  Box,
  Cylinder,
  Disc,
  FaceRect,
  IsoArt,
  fit,
  shade,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const LIST: BoxShape = { at: [0, 0, 0], size: [2.6, 2, 0.18] };
const LENS = "var(--info)";

export function RepoSearchGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="An empty list of repositories under a magnifying glass"
      view={fit([LIST, { at: [1, 0.6, 0.95], size: [1.9, 1.2, 0.2] }])}
      className={cn("size-24", className)}
    >
      <Box {...LIST}>
        <FaceRect
          box={LIST}
          face="top"
          u={[0.1, 0.42]}
          v={[0.14, 0.24]}
          fill="var(--muted-foreground)"
        />
        {[0.5, 0.74].map((v) => (
          <FaceRect
            key={v}
            box={LIST}
            face="top"
            u={[0.1, 0.9]}
            v={[v, v + 0.04]}
            fill="var(--ring)"
          />
        ))}
      </Box>
      <Disc at={[1.6, 1.15, 0.18]} r={0.55} className="fill-border" />

      <Box at={[1.98, 1.07, 0.95]} size={[0.9, 0.16, 0.1]} tone={tone(LENS)} />
      <Cylinder at={[1.6, 1.15, 0.95]} r={0.55} h={0.1} tone={tone(LENS)}>
        <Disc
          at={[1.6, 1.15, 1.05]}
          r={0.42}
          fill={shade(LENS, "right")}
          stroke={LENS}
        />
      </Cylinder>
    </IsoArt>
  );
}
