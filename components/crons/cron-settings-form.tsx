"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Timer } from "lucide-react";

import { BetaChip } from "@/components/shared/beta-chip";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { Switch } from "@/components/ui/switch";
import { gqlAction } from "@/lib/graphql-client";

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
  jobCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(initial);

  function apply(v: boolean) {
    setEnabled(v);
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
        setEnabled(!v);
        toast.error(res.error);
      }
    });
  }

  const noun = targetKind === "app" ? "this app" : "this database";

  return (
    <FeatureRow
      id="cron-jobs"
      icon={Timer}
      title="Cron jobs"
      badge={<BetaChip />}
      description={
        <>
          Run a command inside {noun}&apos;s container on a schedule, as the
          container&apos;s own user and with no sandbox.
        </>
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={apply}
          disabled={pending}
          aria-label="Cron jobs"
        />
      }
    >
      {!enabled && jobCount > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {jobCount === 1
            ? "1 job is kept and will not run until this is back on."
            : `${jobCount} jobs are kept and will not run until this is back on.`}
        </p>
      )}
    </FeatureRow>
  );
}
