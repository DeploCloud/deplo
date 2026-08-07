"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The master switch for one target's cron jobs — the whole of Settings → Cron
 * jobs.
 *
 * Deliberately ONE control. The per-job settings (schedule, timezone, shell,
 * timeout, retries, overlap) belong to a job and live in its dialog, because two
 * jobs on the same app legitimately want different ones; a target-level default
 * for them would be a knob whose only job is to be overridden. So this page says
 * what the feature is, warns what it costs, and turns it on.
 *
 * Saves the instant it is flipped — the house rule for a switch — and turning it
 * OFF keeps every job. That makes it the pause button as well as the opt-in,
 * which is the behaviour somebody reaches for when a job is misbehaving at 03:00.
 */

const SET_ENABLED = /* GraphQL */ `
  mutation ($targetKind: String!, $targetId: ID!, $enabled: Boolean!) {
    setCronEnabled(targetKind: $targetKind, targetId: $targetId, enabled: $enabled)
  }
`;

export function CronSettingsForm({
  targetKind,
  targetId,
  enabled: initial,
  jobCount,
}: {
  targetKind: "app" | "database";
  targetId: string;
  enabled: boolean;
  /** How many jobs stop firing when this goes off. */
  jobCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(initial);

  function apply(v: boolean) {
    setEnabled(v); // optimistic
    startTransition(async () => {
      const res = await gqlAction(SET_ENABLED, {
        targetKind,
        targetId,
        enabled: v,
      });
      if (res.ok) {
        toast.success(v ? "Cron jobs are on" : "Cron jobs are off");
        router.refresh();
      } else {
        setEnabled(!v); // rollback
        toast.error(res.error);
      }
    });
  }

  const noun = targetKind === "app" ? "this app" : "this database";

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              Run scheduled commands
              {/* Said once, where the decision is made. `info` and not `warning`:
                  this is a maturity note, not something wrong. */}
              <Badge variant="info" className="text-[10px] font-normal">
                Beta
              </Badge>
            </p>
            {/* One line, and it names the two things somebody has to already
                know: what runs, and with what privileges. An advanced feature
                earns a warning, not a paragraph. */}
            <p className="mt-1 text-sm text-muted-foreground">
              Runs any command you write inside {noun}&apos;s container, as the
              container&apos;s own user and with no sandbox. Still new - expect
              the odd rough edge, and tell us about it.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={apply}
            disabled={pending}
            aria-label="Run scheduled commands"
          />
        </div>
        {/* Only when it says something the switch does not: turning it off is
            reversible and destroys nothing, so this is information rather than a
            confirmation dialog. */}
        {!enabled && jobCount > 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            {jobCount === 1
              ? "1 job is kept and will not run until this is back on."
              : `${jobCount} jobs are kept and will not run until this is back on.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
