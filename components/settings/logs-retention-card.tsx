"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Save, ScrollText } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { MAX_LOG_RANGE_DAYS, MIN_LOG_RANGE_DAYS } from "@/lib/types";

/**
 * How far back the log viewer's time range may reach. Instance-wide, because the
 * logs live on the HOST and a host is what several teams share.
 */
export function LogsRetentionCard({ logMaxDays }: { logMaxDays: number }) {
  const router = useRouter();
  const [value, setValue] = React.useState(String(logMaxDays));
  const [saved, setSaved] = React.useState(String(logMaxDays));
  const [pending, startTransition] = React.useTransition();
  const dirty = value.trim() !== saved;

  // Empty reads as the floor rather than NaN, which is what the field holds
  // mid-edit after a backspace.
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="size-4 text-muted-foreground" />
            Logs
          </CardTitle>
          <CardDescription>
            How far back the time range on a log page can reach.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-4 sm:max-w-xs">
          <div className="space-y-2">
            <FieldLabel
              htmlFor="log-max-days"
              info="A limit on what can be asked for, not on what a server keeps. Docker rotates a container's logs by size, so an older window can come back empty."
              docs="logs.retention"
            >
              Maximum range
            </FieldLabel>
            {/* The unit rides inside the field: "7" alone reads as anything. */}
            <div className="relative">
              <Input
                id="log-max-days"
                type="number"
                inputMode="numeric"
                min={MIN_LOG_RANGE_DAYS}
                max={MAX_LOG_RANGE_DAYS}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className={cn(
                  "pr-14",
                  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
                )}
              />
              <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-xs font-medium text-muted-foreground">
                {parsed === 1 ? "day" : "days"}
              </span>
            </div>
          </div>
        </CardContent>

        <CardFooter className="justify-between border-t border-border pt-4">
          <DirtyHint dirty={dirty} />
          <Button size="sm" onClick={save} disabled={pending || !dirty}>
            <Save className="size-4" />
            Save
          </Button>
        </CardFooter>
      </Card>

      <UnsavedChangesGuard when={dirty} />
    </>
  );
}
