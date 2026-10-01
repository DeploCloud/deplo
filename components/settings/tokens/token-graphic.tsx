import {
  Box,
  Decal,
  IsoArt,
  UNIT,
  fit,
  floor,
  type BoxShape,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const FLOOR: BoxShape = { at: [1.4, -0.4, 0], size: [2.6, 2.2, 0] };
const LOCK: BoxShape = { at: [2, 0, 0], size: [1.4, 1.2, 1.4] };
const HOLE = 0.7;
const SHAFT = 1.1 * UNIT;
const BOW = 0.32 * UNIT;

export function TokenGraphic({ className }: { className?: string }) {
  const [x, y, z] = LOCK.at;
  const [, d, h] = LOCK.size;
  return (
    <IsoArt
      label="A key drawing itself, its teeth cut one after the other, then turning in a lock that opens"
      view={fit(
        [FLOOR, LOCK, { at: [x, y + d, z + HOLE], size: [0, 2.8, 1.2] }],
        10,
      )}
      className={cn("size-32", className)}
    >
      <Box {...FLOOR} tone={floor} />
      <Box {...LOCK}>
        <Decal
          face="left"
          at={[x + HOLE, y + d, z + HOLE]}
          style={{ stroke: "none" }}
        >
          <circle r={0.11 * UNIT} fill="var(--ring)" />
          <path
            d={`M${-0.07 * UNIT} 0h${0.14 * UNIT}l${0.04 * UNIT} ${0.3 * UNIT}h${-0.22 * UNIT}Z`}
            fill="var(--ring)"
          />
        </Decal>
      </Box>

      {/* The shackle stands in the lock's middle plane and is clipped at its top. */}
      <Decal face="left" at={[x, y + d / 2, z + h]}>
        <clipPath id="iso-token-above">
          <rect x={-UNIT} y={-3 * UNIT} width={3 * UNIT} height={3 * UNIT} />
        </clipPath>
        <g clipPath="url(#iso-token-above)">
          <path
            className="iso-token-shackle"
            d={`M${0.3 * UNIT} ${0.3 * UNIT}V${-0.55 * UNIT}a${0.4 * UNIT} ${0.4 * UNIT} 0 0 1 ${0.8 * UNIT} 0V${0.3 * UNIT}`}
            stroke="var(--ring)"
            strokeWidth="4"
          />
        </g>
      </Decal>

      {/* The key lies in a plane square to the face, through the keyhole: u runs into the lock. */}
      <Decal face="right" at={[x + HOLE, y + d, z + HOLE]}>
        <clipPath id="iso-token-outside">
          <rect
            x={-4 * UNIT}
            y={-2 * UNIT}
            width={4 * UNIT}
            height={4 * UNIT}
          />
        </clipPath>
        <g clipPath="url(#iso-token-outside)">
          <g className="iso-token-key">
            <g className="iso-token-insert">
              <g className="iso-token-turn" fill="var(--chart-4)">
                <g transform={`translate(${-0.6 * UNIT} 0)`}>
                  <path
                    className="iso-token-bow"
                    fillRule="evenodd"
                    d={`M${-SHAFT - 2 * BOW} 0a${BOW} ${BOW} 0 1 0 ${2 * BOW} 0a${BOW} ${BOW} 0 1 0 ${-2 * BOW} 0ZM${-SHAFT - 1.45 * BOW} 0a${0.45 * BOW} ${0.45 * BOW} 0 1 0 ${0.9 * BOW} 0a${0.45 * BOW} ${0.45 * BOW} 0 1 0 ${-0.9 * BOW} 0Z`}
                  />
                  <rect
                    className="iso-token-shaft"
                    x={-SHAFT}
                    y={-0.07 * UNIT}
                    width={SHAFT}
                    height={0.14 * UNIT}
                  />
                  <rect
                    className="iso-token-tooth"
                    x={-0.42 * UNIT}
                    y={0.05 * UNIT}
                    width={0.1 * UNIT}
                    height={0.18 * UNIT}
                  />
                  <rect
                    className="iso-token-tooth"
                    x={-0.24 * UNIT}
                    y={0.05 * UNIT}
                    width={0.1 * UNIT}
                    height={0.26 * UNIT}
                    style={{ animationDelay: "0.2s" }}
                  />
                </g>
              </g>
            </g>
          </g>
        </g>
      </Decal>
    </IsoArt>
  );
}
