import {
  Box,
  Decal,
  IsoArt,
  Path,
  Ring,
  UNIT,
  fit,
  floor,
  plain,
  tone,
  type BoxShape,
  type P,
  type Tone,
} from "@/components/iso/iso";
import { DEPLO, Mark } from "@/components/iso/parts";

// Two windows in one screen row (the new one steps +x and -y), joined on the floor.
const OLD_PAD: BoxShape = { at: [-0.2, -0.4, 0], size: [2.2, 1, 0] };
const OLD: BoxShape = { at: [0, 0, 0], size: [1.8, 0.2, 1.3] };
const NEW_PAD: BoxShape = { at: [2.4, -3, 0], size: [2.2, 1, 0] };
const NEW: BoxShape = { at: [2.6, -2.6, 0], size: [1.8, 0.2, 1.3] };
const WIRE: P[] = [
  [2, 0.1, 0],
  [2.6, 0.1, 0],
  [2.6, -2, 0],
];

const W = 1.8 * UNIT;

function Window({
  box,
  tone: t,
  ink,
  pill,
}: {
  box: BoxShape;
  tone: Tone;
  ink: string;
  pill: string;
}) {
  const [x, y, z] = box.at;
  return (
    <Box {...box} tone={t}>
      <Decal face="left" at={[x, y + box.size[1], z + box.size[2]]}>
        <g stroke="none" fill={ink}>
          <path d={`M0 16H${W}`} stroke={ink} strokeWidth="1.5" />
          {[8, 15, 22].map((cx) => (
            <circle key={cx} cx={cx} cy={8} r={2.5} />
          ))}
          <rect x={32} y={4} width={46} height={8} rx={4} fill={pill} />
          <rect x={10} y={30} width={60} height={5} rx={2.5} />
          <rect x={10} y={42} width={42} height={5} rx={2.5} />
        </g>
      </Decal>
    </Box>
  );
}

export function PanelMoveGraphic() {
  return (
    <IsoArt
      label="The panel moving from its old address to its new one"
      view={fit(
        [OLD_PAD, OLD, NEW_PAD, NEW, { at: [2, 0, 0], size: [0.6, 0.4, 0] }],
        10,
      )}
      className="h-24 w-auto max-w-full sm:h-28"
    >
      <Box {...OLD_PAD} tone={floor} />
      <Box {...NEW_PAD} tone={floor} />
      <Ring {...NEW_PAD} color="var(--success)" className="iso-panel-ring" />
      <Path
        points={WIRE}
        stroke="var(--ring)"
        strokeWidth="1.5"
        strokeDasharray="6 2"
        className="iso-march"
      />
      <g className="iso-panel-packet">
        <Box
          at={[1.85, -0.05, 0]}
          size={[0.3, 0.3, 0.3]}
          tone={tone("var(--warning)")}
        />
      </g>

      <Window
        box={OLD}
        tone={plain}
        ink="var(--ring)"
        pill="var(--muted-foreground)"
      />
      <Window box={NEW} tone={DEPLO} ink={DEPLO.right} pill="var(--success)" />
      <Mark at={[3.95, -2.4, 0.55]} size={0.32} />
    </IsoArt>
  );
}
