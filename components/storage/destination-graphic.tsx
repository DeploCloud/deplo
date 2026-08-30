import { cn } from "@/lib/utils";

/** The backup destinations empty-state illustration: a copy tossed off the box and into a bucket. */
export function DestinationGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A copy arcing through the air into a storage bucket"
      className={cn("size-32", className)}
    >
      <line
        x1="8"
        y1="70"
        x2="112"
        y2="70"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g
        stroke="var(--chart-5)"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <ellipse cx="88" cy="44" rx="14" ry="4.5" />
        <path d="M74 44 L79 70 L97 70 L102 44" />
      </g>

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
