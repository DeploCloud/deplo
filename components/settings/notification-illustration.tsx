import {
  ChannelMark,
  CHANNEL_BRAND,
} from "@/components/settings/channel-brand";
import type { NotificationChannel } from "@/lib/types";

/** A phone catching alerts as they land - the one picture that says what this page is for before anybody reads a switch. */

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
    delay: "2.6s",
  },
  {
    channel: "pushover",
    title: "Backed up quotedb",
    body: "412 MB uploaded.",
    delay: "5.2s",
  },
];

export function NotificationIllustration({
  caption = true,
}: {
  caption?: boolean;
} = {}) {
  return (
    <div aria-hidden className="pointer-events-none select-none">
      <div className="relative mx-auto w-full max-w-[260px]">
        <div className="animate-notif-halo absolute inset-x-4 top-10 -z-10 h-56 rounded-full bg-[var(--violet)]/25 blur-3xl" />

        <div className="relative overflow-hidden rounded-[2rem] border-[6px] border-border bg-sidebar shadow-xl ring-1 ring-border">
          <div className="flex justify-center pt-2">
            <div className="h-1.5 w-16 rounded-full bg-border" />
          </div>

          <div className="space-y-2.5 px-3 pt-5 pb-8">
            {INBOX.map((n) => (
              <div
                key={n.channel}
                className="animate-notif-card flex items-start gap-2.5 rounded-xl border border-border bg-background/80 p-2.5 shadow-sm backdrop-blur"
                style={{ ["--notif-delay" as string]: n.delay }}
              >
                <ChannelMark
                  channel={n.channel}
                  className="size-7 rounded-md"
                  iconClassName="size-3.5"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] leading-tight font-medium">
                    {n.title}
                  </p>
                  <p className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground">
                    {n.body}
                  </p>
                </div>
                <span
                  className="mt-1 size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: CHANNEL_BRAND[n.channel].bg }}
                />
              </div>
            ))}
          </div>

          <div className="flex justify-center pb-2">
            <div className="h-1 w-20 rounded-full bg-border" />
          </div>
        </div>
      </div>

      {caption && (
        <p className="mt-4 text-center text-xs leading-snug text-muted-foreground">
          Deplo tells you what happened, on the channels you pick, wherever you
          are.
        </p>
      )}
    </div>
  );
}
