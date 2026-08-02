"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The team-wide two-factor policy.
 *
 * One switch, because that is the whole decision: either this team's work is
 * behind a second factor or it is not. The member count under it exists so an
 * admin sees who they are about to interrupt BEFORE flipping it, rather than
 * finding out from the people who can suddenly do nothing.
 */
export function TeamSecurityCard({
  name,
  slug,
  requireTwoFactor,
  canManage,
  without,
  total,
}: {
  name: string;
  slug: string;
  requireTwoFactor: boolean;
  canManage: boolean;
  /** Members of this team with no second factor yet. */
  without: number;
  total: number;
}) {
  const router = useRouter();
  const [on, setOn] = React.useState(requireTwoFactor);
  const [pending, startTransition] = React.useTransition();

  function toggle(next: boolean) {
    // Optimistic: the switch moves now and snaps back if the server refuses
    // (which it does when the actor has no second factor of their own).
    setOn(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($input: UpdateTeamInput!) { updateTeam(input: $input) { id } }`,
        { input: { name, slug, requireTwoFactor: next } },
      );
      if (res.ok) {
        toast.success(
          next
            ? "Members now need two-factor authentication"
            : "Two-factor authentication is no longer required",
        );
        router.refresh();
      } else {
        setOn(!next);
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Security
          <InfoTip content="Team-wide rules that apply to everyone in this team, whatever their role." />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Require two-factor authentication
            </p>
            <p className="text-xs text-muted-foreground">
              Members without it cannot use this team, through the dashboard or
              the API, until they turn it on.
            </p>
            {without > 0 && (
              <p className="text-xs text-[var(--warning)]">
                {without} of {total} member{total === 1 ? "" : "s"}{" "}
                {without === 1 ? "does" : "do"} not have it yet
                {on
                  ? " and cannot use this team right now."
                  : " and will be asked to set it up."}
              </p>
            )}
          </div>
          <Switch
            checked={on}
            onCheckedChange={toggle}
            disabled={!canManage || pending}
            aria-label="Require two-factor authentication"
          />
        </div>
      </CardContent>
    </Card>
  );
}
