"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Timer } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The master switch for one target's cron jobs. Deliberately ONE control: the
 * per-job settings belong to a job. Renders the ROW, not the card, and turning it
 * OFF keeps every job, so it doubles as the pause button. */

const SET_ENABLED = /* GraphQL */ `
  mutation ($targetKind: String!, $targetId: ID!, $enabled: Boolean!) {
    setCronEnabled(
      targetKind: $targetKind
      targetId: $targetId
      enabled: $enabled
    )
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
    <div id="cron-jobs" className="scroll-mt-20 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-56 flex-1 space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Timer className="size-4 text-muted-foreground" />
            Cron jobs
            {/* Said once, where the decision is made. `info` and not `warning`:
                this is a maturity note, not something wrong. */}
            <Badge variant="info" className="text-[10px] font-normal">
              Beta
            </Badge>
          </p>
          {/* One line, and it names the two things somebody has to already
              know: what runs, and with what privileges. An advanced feature
              earns a warning, not a paragraph. */}
          <p className="text-sm text-muted-foreground">
            Run a command inside {noun}&apos;s container on a schedule, as the
            container&apos;s own user and with no sandbox.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={apply}
          disabled={pending}
          aria-label="Cron jobs"
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
    </div>
  );
}
