import {
  Box,
  Cylinder,
  Disc,
  FaceRect,
  IsoArt,
  Path,
  fit,
  floor,
  tone,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const VIOLET = "var(--violet)";
const FLOOR: BoxShape = { at: [0, 0, 0], size: [3, 3, 0] };
const H = 0.8;
const SOURCE: BoxShape = { at: [1.1, 1.1, 2.3], size: [0.8, 0.8, 0.25] };
const JOIN = 1.8;
// Each app's centre, left to right on screen, and its branch from the source.
const APPS: { at: P; route: P[] }[] = [
  {
    at: [0.1, 2.1, 0],
    route: [
      [1.5, 1.5, JOIN],
      [1.5, 2.5, JOIN],
      [0.5, 2.5, JOIN],
      [0.5, 2.5, H],
    ],
  },
  {
    at: [1.1, 1.1, 0],
    route: [
      [1.5, 1.5, JOIN],
      [1.5, 1.5, H],
    ],
  },
  {
    at: [2.1, 0.1, 0],
    route: [
      [1.5, 1.5, JOIN],
      [1.5, 0.5, JOIN],
      [2.5, 0.5, JOIN],
      [2.5, 0.5, H],
    ],
  },
];

export function SharedVarsGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="One shared variable streaming down into three apps at once"
      view={fit([FLOOR, { ...SOURCE, size: [0.8, 0.8, 0.3] }])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      {APPS.map(({ at }, i) => {
        const app: BoxShape = { at, size: [0.8, 0.8, H] };
        return (
          <Box key={i} {...app}>
            <FaceRect
              box={app}
              face="left"
              u={[0.15, 0.6]}
              v={[0.7, 0.78]}
              fill="var(--border)"
            />
          </Box>
        );
      })}

      <Path
        points={[
          [1.5, 1.5, 2.3],
          [1.5, 1.5, JOIN],
        ]}
        stroke={VIOLET}
        strokeWidth="1.5"
        strokeDasharray="4 4"
        className="iso-svars-flow"
      />
      {APPS.map(({ route }, i) => (
        <Path
          key={i}
          points={route}
          stroke={VIOLET}
          strokeWidth="1.5"
          strokeDasharray="4 4"
          className="iso-svars-flow"
        />
      ))}

      {APPS.map(({ at }, i) => (
        <Cylinder
          key={i}
          at={[at[0] + 0.4, at[1] + 0.4, H]}
          r={0.16}
          h={0.08}
          tone={tone(VIOLET)}
          className="iso-svars-dot"
          style={{ animationDelay: `${i === 1 ? 0 : 0.25 * i}s` }}
        />
      ))}

      <Box {...SOURCE} tone={tone(VIOLET)}>
        <FaceRect
          box={SOURCE}
          face="left"
          u={[0.15, 0.55]}
          v={[0.35, 0.65]}
          fill="var(--iso-base)"
        />
      </Box>
      {[0.68, 0.84].map((u) => (
        <Disc
          key={u}
          at={[1.1 + u * 0.8, 1.5, 2.55]}
          r={0.05}
          fill="var(--iso-base)"
        />
      ))}
    </IsoArt>
  );
}
