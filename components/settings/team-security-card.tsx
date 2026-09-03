"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import { TwoFactorGraphic } from "@/components/settings/two-factor-graphic";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The team-wide two-factor policy. One switch, because that is the whole decision:
 * either this team's work is behind a second factor or it is not.
 */
export function TeamSecurityCard({
  requireTwoFactor,
  canManage,
  without,
  total,
}: {
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
        { input: { requireTwoFactor: next } },
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
    // A flex column so the illustration takes the slack: the card's height is
    // set by its neighbour in the row, and the content has to reach the bottom.
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Security
          <InfoTip
            content="Team-wide rules that apply to everyone in this team, whatever their role."
            docs="team.requireTwoFactor"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {/* The box still takes the slack, so the card keeps its neighbour's
            height; the drawing is capped at its own 80px so a tall card stops
            blowing it up. */}
        <div className="flex min-h-0 flex-1 items-center justify-center py-2">
          <TwoFactorGraphic className="max-h-20" />
        </div>
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Require two-factor authentication
            </p>
            <p className="text-xs text-muted-foreground">
              Members without it cannot use this team, through the dashboard or
              the API, until they turn it on.
            </p>
          </div>
          <Switch
            checked={on}
            onCheckedChange={toggle}
            disabled={!canManage || pending}
            aria-label="Require two-factor authentication"
          />
        </div>
        {without > 0 && (
          <div className="flex items-center gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
            <AlertTriangle className="size-5 shrink-0 text-[var(--warning)]" />
            <p className="text-sm">
              {without} of {total} member{total === 1 ? "" : "s"}{" "}
              {without === 1 ? "does" : "do"} not have it yet
              {on
                ? " and cannot use this team right now."
                : " and will be asked to set it up."}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
