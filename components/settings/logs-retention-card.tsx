"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Logs, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { MAX_LOG_RANGE_DAYS, MIN_LOG_RANGE_DAYS } from "@/lib/types/deployment";

export function LogsRetentionCard({ logMaxDays }: { logMaxDays: number }) {
  const router = useRouter();
  const [value, setValue] = React.useState(String(logMaxDays));
  const [saved, setSaved] = React.useState(String(logMaxDays));
  const [pending, startTransition] = React.useTransition();
  const dirty = value.trim() !== saved;

  const parsed = Math.min(
    MAX_LOG_RANGE_DAYS,
    Math.max(
      MIN_LOG_RANGE_DAYS,
      Math.trunc(Number(value) || MIN_LOG_RANGE_DAYS),
    ),
  );

  function save() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($days: Int!) {
           setLogMaxDays(days: $days) { logMaxDays }
         }`,
        { days: parsed },
      );
      if (res.ok) {
        setValue(String(parsed));
        setSaved(String(parsed));
        router.refresh();
        toast.success(
          `Logs can be searched back ${parsed} ${parsed === 1 ? "day" : "days"}`,
        );
      } else toast.error(res.error);
    });
  }

  return (
    <>
      <SettingItem
        icon={Logs}
        title="Log search range"
        htmlFor="log-max-days"
        info="A limit on what can be asked for, not on what a server keeps. Docker rotates a container's logs by size, so an older window can come back empty."
        docs="logs.retention"
        description="How far back the time range on a log page can reach."
        control={
          <>
            <DirtyHint dirty={dirty} />
            <div className="relative w-28">
              <Input
                id="log-max-days"
                type="number"
                inputMode="numeric"
                min={MIN_LOG_RANGE_DAYS}
                max={MAX_LOG_RANGE_DAYS}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className={cn(
                  "pr-12",
                  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
                )}
              />
              <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-xs font-medium text-muted-foreground">
                {parsed === 1 ? "day" : "days"}
              </span>
            </div>
            <Button onClick={save} disabled={pending || !dirty}>
              <Save className="size-4" />
              Save
            </Button>
          </>
        }
      />

      <UnsavedChangesGuard when={dirty} />
    </>
  );
}
