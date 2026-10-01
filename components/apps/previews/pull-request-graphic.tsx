import {
  Box,
  Cylinder,
  Disc,
  IsoArt,
  Path,
  fit,
  floor,
  plain,
  tone,
  type BoxShape,
  type P,
} from "@/components/iso/iso";
import { cn } from "@/lib/utils";

const BOARD: BoxShape = { at: [0, 0, 0], size: [3.6, 2.3, 0.25] };
const Z = 0.25;
const TRUNK = 1.7;
const SIDE = 0.55;
const FORK = 0.8;
const MERGE: P = [3.0, TRUNK, Z];
const COMMITS: P[] = [
  [1.65, SIDE, Z],
  [2.25, SIDE, Z],
];

const bezier = (a: P, b: P, c: P, d: P, steps = 14): P[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const k = [
      (1 - t) ** 3,
      3 * (1 - t) ** 2 * t,
      3 * (1 - t) * t ** 2,
      t ** 3,
    ];
    return [0, 1, 2].map((j) =>
      [a, b, c, d].reduce((sum, p, n) => sum + p[j] * k[n], 0),
    ) as P;
  });

// Out of the trunk, along the side, back in: the flat graph laid on the floor.
const BRANCH: P[] = [
  ...bezier(
    [FORK, TRUNK, Z],
    [1.2, TRUNK, Z],
    [1.05, SIDE, Z],
    [1.45, SIDE, Z],
  ),
  ...bezier([2.4, SIDE, Z], [2.75, SIDE, Z], [2.6, TRUNK, Z], MERGE),
];

const ink = "var(--violet)";

export function PullRequestGraphic({
  variant = "active",
  className,
}: {
  variant?: "active" | "off";
  className?: string;
}) {
  const off = variant === "off";
  return (
    <IsoArt
      label={
        off
          ? "A branch that starts and stops before it can merge"
          : "A branch merging back into the main branch"
      }
      view={fit([BOARD, { at: [0, 0, 0], size: [3.6, 2.3, 0.7] }])}
      className={cn("size-32", className)}
    >
      <Box {...BOARD} tone={floor} />
      <Path
        points={[
          [0.35, TRUNK, Z],
          [3.35, TRUNK, Z],
        ]}
        stroke="var(--ring)"
        strokeWidth="2.5"
      />
      <Cylinder at={[0.35, TRUNK, Z]} r={0.16} h={0.2} tone={plain} />

      {off ? (
        <>
          <Path
            points={BRANCH}
            stroke="var(--ring)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <Disc
            at={MERGE}
            r={0.24}
            stroke="var(--muted-foreground)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            fill="var(--iso-floor)"
          />
          <Path
            points={BRANCH}
            pathLength={1}
            stroke={ink}
            strokeWidth="5"
            style={{ vectorEffect: "none" }}
            className="iso-pr-stall"
          />
        </>
      ) : (
        <>
          <Path
            points={BRANCH}
            pathLength={1}
            stroke={ink}
            strokeWidth="5"
            style={{ vectorEffect: "none" }}
            className="iso-pr-branch"
          />
          {COMMITS.map((at, i) => (
            <g
              key={i}
              className="iso-pr-pop"
              style={{ animationDelay: `${i * 0.3 - 0.6}s` }}
            >
              <Cylinder at={at} r={0.18} h={0.3} tone={tone(ink)} />
            </g>
          ))}
          <g className="iso-pr-pop" style={{ animationDelay: "0.15s" }}>
            <Cylinder
              at={MERGE}
              r={0.24}
              h={0.42}
              tone={tone("var(--success)")}
            />
          </g>
        </>
      )}
    </IsoArt>
  );
}
