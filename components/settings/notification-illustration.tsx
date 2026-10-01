import { CHANNEL_BRAND } from "@/components/settings/channel-brand";
import {
  Box,
  Decal,
  FaceRect,
  IsoArt,
  UNIT,
  beat,
  fit,
  floor,
  type BoxShape,
} from "@/components/iso/iso";
import type { NotificationChannel } from "@/lib/types/notification";

const INBOX: {
  channel: NotificationChannel;
  title: string;
  body: string;
  delay: string;
}[] = [
  {
    channel: "discord",
    title: "api failed to deploy",
    body: "The build log has the error.",
    delay: "0s",
  },
  {
    channel: "ntfy",
    title: "eu-main-1 disk at 92%",
    body: "Deploys fail when it fills.",
    delay: "-5.2s",
  },
  {
    channel: "pushover",
    title: "Backed up quotedb",
    body: "412 MB uploaded.",
    delay: "-2.6s",
  },
];

// A phone standing on its end, screen forward; each alert is a card floating on it.
const PHONE: BoxShape = { at: [0, 0, 0], size: [3, 0.3, 3.6] };
const PAD: BoxShape = { at: [-0.4, -0.4, 0], size: [3.8, 1.5, 0] };
const CARD = { x: -0.1, y: 0.42, w: 3.2, d: 0.1, h: 0.85 };
const cardZ = (i: number) => 2.45 - i * 1.02;

export function NotificationIllustration({
  caption = true,
}: {
  caption?: boolean;
} = {}) {
  const W = CARD.w * UNIT;
  const H = CARD.h * UNIT;
  return (
    <div aria-hidden className="pointer-events-none select-none">
      <IsoArt
        label="Alerts from three channels landing on a phone"
        view={fit([PAD, PHONE, { at: [-0.1, 0, 0], size: [3.2, 0.6, 3.6] }], 8)}
        className="mx-auto h-auto w-full max-w-[240px]"
      >
        <Box {...PAD} tone={floor} />
        <Box {...PHONE}>
          <FaceRect
            box={PHONE}
            face="left"
            u={[0.05, 0.95]}
            v={[0.03, 0.97]}
            fill="var(--iso-floor)"
          />
          <FaceRect
            box={PHONE}
            face="right"
            u={[0.3, 0.7]}
            v={[0.6, 0.66]}
            fill="var(--ring)"
          />
        </Box>

        {INBOX.map((n, i) => {
          const z = cardZ(i);
          const brand = CHANNEL_BRAND[n.channel];
          const Icon = brand.icon;
          return (
            <g
              key={n.channel}
              className="iso-notif-card"
              style={{ animationDelay: n.delay }}
            >
              <Box at={[CARD.x, CARD.y, z]} size={[CARD.w, CARD.d, CARD.h]}>
                <Decal face="left" at={[CARD.x, CARD.y + CARD.d, z + CARD.h]}>
                  <rect
                    x={8}
                    y={H / 2 - 14}
                    width={28}
                    height={28}
                    rx={6}
                    fill={brand.bg}
                    stroke="none"
                  />
                  <g color={brand.fg} stroke="none">
                    {Icon ? (
                      <svg x={15} y={H / 2 - 7} width={14} height={14}>
                        <Icon />
                      </svg>
                    ) : (
                      <text
                        x={22}
                        y={H / 2 + 4.5}
                        textAnchor="middle"
                        fontSize={13}
                        fontWeight={600}
                        fill={brand.fg}
                      >
                        {brand.initial}
                      </text>
                    )}
                  </g>
                  <text
                    x={44}
                    y={H / 2 - 3}
                    fontSize={10.5}
                    fontWeight={600}
                    fill="var(--foreground)"
                    stroke="none"
                  >
                    {n.title}
                  </text>
                  <text
                    x={44}
                    y={H / 2 + 11}
                    fontSize={9}
                    fill="var(--muted-foreground)"
                    stroke="none"
                  >
                    {n.body}
                  </text>
                  <circle
                    cx={W - 9}
                    cy={H / 2 - 7}
                    r={3}
                    fill={brand.bg}
                    stroke="none"
                    className="iso-blink"
                    style={beat(i)}
                  />
                </Decal>
              </Box>
            </g>
          );
        })}
      </IsoArt>

      {caption && (
        <p className="mt-4 text-center text-xs leading-snug text-muted-foreground">
          Deplo tells you what happened, on the channels you pick, wherever you
          are.
        </p>
      )}
    </div>
  );
}
