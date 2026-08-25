"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Save, Undo2 } from "lucide-react";
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
import { MAX_ROLLBACK_KEEP } from "@/lib/types";

/**
 * How many previous deployments this app can be put back on.
 */
export function RollbackSettingsForm({
  appId,
  rollbackKeep,
}: {
  appId: string;
  rollbackKeep: number;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState(String(rollbackKeep));
  const [saved, setSaved] = React.useState(String(rollbackKeep));
  const [pending, startTransition] = React.useTransition();
  const dirty = value.trim() !== saved;

  // Empty reads as 0 ("keep none") rather than NaN, which is what the field shows
  // mid-edit after a backspace.
  const parsed = Math.min(
    MAX_ROLLBACK_KEEP,
    Math.max(0, Math.trunc(Number(value) || 0)),
  );

  function save() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $count: Int!) {
           setAppRollbackKeep(id: $id, count: $count) { id }
         }`,
        { id: appId, count: parsed },
      );
      if (res.ok) {
        setValue(String(parsed));
        setSaved(String(parsed));
        router.refresh();
        toast.success(
          parsed === 0
            ? "Rollbacks turned off for this app"
            : `Keeping ${parsed} ${parsed === 1 ? "rollback" : "rollbacks"}`,
        );
      } else toast.error(res.error);
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Undo2 className="size-4 text-muted-foreground" />
            Rollbacks
          </CardTitle>
          <CardDescription>
            Go back to an earlier deployment in seconds, without rebuilding.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-4 sm:max-w-xs">
          <div className="space-y-2">
            <FieldLabel
              htmlFor="rollback-keep"
              info="Each one is a copy of the app kept on its server, so more rollbacks means more disk. Older ones are removed after each deploy. 0 keeps none."
            >
              Keep
            </FieldLabel>
            {/* The unit rides inside the field: "3" alone gives no clue what it
                counts, and this number is easy to read as days. */}
            <div className="relative">
              <Input
                id="rollback-keep"
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_ROLLBACK_KEEP}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className={cn(
                  "pr-20",
                  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
                )}
              />
              <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-xs font-medium text-muted-foreground">
                {parsed === 1 ? "rollback" : "rollbacks"}
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
