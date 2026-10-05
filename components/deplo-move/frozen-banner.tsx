import { CalendarClock, CirclePause, Copy } from "lucide-react";
import type { ElementType, ReactNode } from "react";

import Link from "@/components/ui/link";
import { moveBanner } from "@/lib/data/deplo-move/target";
import { TurnOnSchedules } from "./turn-on-schedules";

// A slim strip under the top bar while a Deplo move is under way here, or has left schedules paused.
function Strip({
  message,
  progressHref,
  icon: Icon = CirclePause,
  action,
}: {
  message: string;
  progressHref: string | null;
  icon?: ElementType;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/40 bg-warning-wash px-4 py-2 text-sm text-warning sm:px-6 lg:px-8"
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{message}</span>
      {progressHref && (
        <Link
          href={progressHref}
          className="font-medium underline underline-offset-2 hover:no-underline"
        >
          Show progress
        </Link>
      )}
      {action}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || "the old Deplo";
  }
}

// Every banner a move puts on this Deplo, for anyone signed in; only an instance admin gets the links.
export async function MoveBanner() {
  const b = await moveBanner();
  if (!b) return null;
  const from = hostOf(b.peerUrl);
  const phase =
    b.phase === "copying"
      ? {
          icon: CirclePause,
          message: `Copying from ${from}: changes are paused until its data is in.`,
        }
      : b.phase === "deploying"
        ? {
            icon: Copy,
            message: `Copying from ${from}: apps here may restart.`,
          }
        : b.phase === "stopped"
          ? {
              icon: CirclePause,
              message: `Copying from ${from} stopped before it finished.`,
            }
          : null;
  return (
    <>
      {phase && (
        <Strip
          icon={phase.icon}
          message={phase.message}
          progressHref={b.progressPath}
        />
      )}
      {b.schedulesPaused && (
        <Strip
          icon={CalendarClock}
          message="Scheduled jobs and backups are paused so they don't run twice."
          progressHref={null}
          action={b.canResumeSchedules ? <TurnOnSchedules /> : null}
        />
      )}
    </>
  );
}
