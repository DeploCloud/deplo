"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
 * Whether somebody with no uploaded picture falls back to their Gravatar.
 *
 * On by default, because a picture nobody had to upload is the whole point. It
 * is here, on an instance-admin page, rather than as a per-person preference
 * because the question it answers is not "which picture do I like" — it is
 * whether this company's staff addresses may be looked up against a service
 * outside it. That is one decision for the instance, not one per member.
 *
 * The panel itself never dials gravatar.com either way; it computes the address
 * and each viewer's browser fetches it. Off simply stops the address being
 * emitted, which is also what makes this work on an instance with no egress.
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
            info="Each person's browser fetches the picture from gravatar.com using a hash of their address. Turn it off and nothing about anyone leaves this instance — everyone without an uploaded picture wears their initials."
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
