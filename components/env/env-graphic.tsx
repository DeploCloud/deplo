import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  fit,
  floor,
  tone,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [-0.3, -0.3, 0], size: [3.8, 1.9, 0] };
const LIST: BoxShape = { at: [0, 0, 0], size: [3.2, 0.35, 1.9] };
const LOCK: BoxShape = { at: [2.45, 0.95, 0], size: [0.5, 0.4, 0.45] };
// Readable characters: x on the list's face, and how tall each one stands.
const CHARS: [number, number][] = [
  [84, 11],
  [97, 7],
  [110, 14],
  [123, 8],
];

export function EnvGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A variable being written into a list, its value scrambled and locked away masked"
      view={fit([FLOOR, LIST])}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Box {...LIST}>
        <FaceRect
          box={LIST}
          face="left"
          u={[0, 1]}
          v={[0.78, 0.8]}
          fill="var(--ring)"
        />
        <FaceRect
          box={LIST}
          face="left"
          u={[0.06, 0.3]}
          v={[0.86, 0.91]}
          fill="var(--border)"
        />
        <Decal face="left" at={[0, 0.35, 1.9]}>
          <g stroke="none" transform="scale(1.3)">
            <rect
              x="14"
              y="47"
              width="36"
              height="9"
              rx="4.5"
              fill="var(--info)"
              className="iso-env-key"
            />
            <g fill="var(--ring)">
              <rect x="58" y="46" width="12" height="3" rx="1.5" />
              <rect x="58" y="54" width="12" height="3" rx="1.5" />
            </g>
            {CHARS.map(([x, h], i) => (
              <rect
                key={x}
                x={x - 3}
                y={51.5 - h / 2}
                width="6"
                height={h}
                rx="3"
                fill="var(--info)"
                className="iso-env-plain"
                style={{ animationDelay: `${i * 0.1}s` }}
              />
            ))}
            {CHARS.map(([x]) => (
              <circle
                key={x}
                cx={x}
                cy="51.5"
                r="4.5"
                fill="var(--info)"
                className="iso-env-dot"
              />
            ))}
          </g>
        </Decal>
      </Box>

      <g className="iso-env-lock">
        <Box {...LOCK} tone={tone("var(--info)")}>
          <FaceRect
            box={LOCK}
            face="left"
            u={[0.44, 0.56]}
            v={[0.3, 0.62]}
            fill="var(--iso-base)"
          />
        </Box>
        <Decal face="left" at={[2.45, 1.15, 0.45]}>
          <path
            d="M7 0 V-13 A6.85 6.85 0 0 1 20.7 -13 V0"
            stroke="var(--info)"
            strokeWidth="2"
            strokeLinecap="round"
            className="iso-env-shackle"
          />
        </Decal>
      </g>
    </IsoArt>
  );
}
