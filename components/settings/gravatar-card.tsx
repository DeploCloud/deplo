"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { UserRound } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Whether somebody with no uploaded picture falls back to their Gravatar. Off by
 * default: it is every member's browser that dials gravatar.com, not the panel.
 */
export function GravatarCard({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [on, setOn] = React.useState(enabled);
  const [pending, startTransition] = React.useTransition();

  function toggle(next: boolean) {
    const previous = on;
    setOn(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($enabled: Boolean!) {
           setGravatarEnabled(enabled: $enabled) { gravatarEnabled }
         }`,
        { enabled: next },
      );
      if (res.ok) {
        router.refresh();
        toast.success(
          next ? "Gravatar pictures are on" : "Gravatar pictures are off",
        );
      } else {
        setOn(previous);
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserRound className="size-4 text-muted-foreground" />
          Profile pictures
        </CardTitle>
        <CardDescription>
          Where a picture comes from when someone has not uploaded one.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <FieldLabel
            htmlFor="gravatar-enabled"
            info="Turn it on and each person's browser fetches their picture from gravatar.com using a hash of their address. Off, nothing about anyone leaves this instance and everyone without an uploaded picture wears their initials."
          >
            Use Gravatar
          </FieldLabel>
          <Switch
            id="gravatar-enabled"
            checked={on}
            disabled={pending}
            onCheckedChange={toggle}
          />
        </div>
      </CardContent>
    </Card>
  );
}
