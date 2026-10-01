import type * as React from "react";
import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  Path,
  UNIT,
  beat,
  fit,
  floor,
  tone,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const WHALE = tone("var(--chart-1)");
const WATER: BoxShape = { at: [-1.8, -0.5, 0], size: [5.2, 2.2, 0] };
const BODY: BoxShape = { at: [0, 0, 0.3], size: [3, 1.2, 1.1] };
const TAIL: BoxShape[] = [
  { at: [-0.6, 0.25, 0.5], size: [0.6, 0.7, 0.6] },
  { at: [-1.1, 0.4, 0.75], size: [0.5, 0.4, 0.5] },
];
const FLUKES: BoxShape = { at: [-1.5, -0.1, 1.2], size: [0.5, 1.4, 0.12] };
const BLOWHOLE: P = [2.7, 0.65, 1.4];

/** A shipping container: ribs down the long face, the registry's blue on its edges. */
function Container({ at }: { at: P }) {
  const box: BoxShape = { at, size: [0.7, 0.9, 0.5] };
  return (
    <Box
      {...box}
      tone={{
        top: "var(--iso-top)",
        left: "var(--iso-left)",
        right: "var(--iso-right)",
        stroke: "var(--chart-1)",
      }}
    >
      {[0.25, 0.5, 0.75].map((u) => (
        <FaceRect
          key={u}
          box={box}
          face="left"
          u={[u - 0.03, u + 0.03]}
          v={[0.15, 0.85]}
          fill="var(--chart-1)"
        />
      ))}
    </Box>
  );
}

export function RegistryGraphic({ className }: { className?: string }) {
  return (
    <IsoArt
      label="A whale floating with a stack of containers on its back"
      view={fit(
        [WATER, BODY, FLUKES, { at: [0.5, 0, 0.3], size: [1.6, 1, 2.1] }],
        10,
      )}
      className={cn("size-32", className)}
    >
      <Box {...WATER} tone={floor} />
      {[
        [-1.2, 0.2],
        [-0.4, 1.4],
        [1.6, 1.7],
        [3.1, 0.4],
      ].map(([x, y], i) => (
        <Path
          key={i}
          points={[
            [x, y, 0],
            [x + 0.8, y, 0],
          ]}
          stroke="var(--ring)"
          strokeWidth="1.5"
          strokeDasharray="6 2"
        />
      ))}

      <g
        className="iso-bob"
        style={{ "--iso-dur": "2s" } as React.CSSProperties}
      >
        <Box {...FLUKES} tone={WHALE} />
        {TAIL.map((t) => (
          <Box key={t.at[0]} {...t} tone={WHALE} />
        ))}
        <Box {...BODY} tone={WHALE}>
          <FaceRect
            box={BODY}
            face="left"
            u={[0, 1]}
            v={[0, 0.22]}
            fill="var(--chart-1)"
          />
          <FaceRect
            box={BODY}
            face="right"
            u={[0, 1]}
            v={[0, 0.22]}
            fill="var(--chart-1)"
          />
          <FaceRect
            box={BODY}
            face="left"
            u={[0.62, 1]}
            v={[0.38, 0.42]}
            fill="var(--iso-base)"
          />
          <Decal face="left" at={[2.5, 1.2, 1.1]}>
            <circle r={0.08 * UNIT} fill="var(--iso-base)" stroke="none" />
          </Decal>
        </Box>

        {[0.15, 0.9, 1.65].map((x) => (
          <Container key={x} at={[x, 0.15, 1.4]} />
        ))}
        {[0.52, 1.27].map((x) => (
          <Container key={x} at={[x, 0.15, 1.9]} />
        ))}

        {[0, 1].map((i) => (
          <g
            key={i}
            className="iso-registry-puff"
            style={beat(i + 3, [2.6, 2.6], [i * 1.3, i * 1.3])}
          >
            <Box
              at={[BLOWHOLE[0] - 0.1, BLOWHOLE[1] - 0.1, BLOWHOLE[2]]}
              size={[0.25, 0.25, 0.25]}
              tone={WHALE}
            />
          </g>
        ))}
      </g>
    </IsoArt>
  );
}
