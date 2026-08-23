import { cn } from "@/lib/utils";

/**
 * The backup destinations empty-state illustration: a copy tossed off the box and
 * into a bucket.
 *
 * "Bucket" is the word every S3 provider uses, so the bucket IS the noun the
 * page is about, and the arc says the rest: a destination is somewhere your data
 * goes that is not this machine. The toss lands, the frame rests, and it goes
 * again - the point of a destination is that it keeps receiving.
 *
 * `--chart-5`. The three tabs of this page have to differ from each other at a
 * glance: Databases is `--chart-4`, Backups is `--chart-1`, this one is teal.
 *
 * Same three-group construction as the tumbleweed next door, for the same
 * reason: travel is linear, the arc has its own easing, and the tumble is linear
 * again - one `transform` property cannot hold three easings. Under
 * `prefers-reduced-motion` it holds the copy mid-flight.
 */
export function DestinationGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A copy arcing through the air into a storage bucket"
      className={cn("size-32", className)}
    >
      {/* The ground: this machine, the thing a destination exists to leave. */}
      <line
        x1="8"
        y1="70"
        x2="112"
        y2="70"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The bucket, sitting on the ground with the copy still in the air: it is
          drawn solid, not dashed, because unlike the missing database this is
          the thing the page is offering to set up. */}
      <g
        stroke="var(--chart-5)"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <ellipse cx="88" cy="44" rx="14" ry="4.5" />
        <path d="M74 44 L79 70 L97 70 L102 44" />
      </g>

      {/* The copy. Placed with an SVG attribute so the three animated transforms
          below start clean, and authored around (0,0) so the tumble turns about
          its own centre. It starts on the ground at the left, then is thrown: X
          linear, Y an arc, a slow tumble on the way. It fades at the rim rather
          than sinking behind it - the bucket is an outline and would not occlude
          anything anyway. */}
      <g transform="translate(26 64.5)">
        <g className="deplo-s3-throw">
          <g className="deplo-s3-arc">
            <g className="deplo-s3-tumble">
              <rect
                x="-5.5"
                y="-5.5"
                width="11"
                height="11"
                rx="2.5"
                fill="var(--chart-5)"
              />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
