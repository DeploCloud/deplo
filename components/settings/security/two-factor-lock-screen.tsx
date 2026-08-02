"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TwoFactorWizard } from "./two-factor-wizard";
import { gqlAction } from "@/lib/graphql-client";

/**
 * What a member sees instead of the dashboard when a team's (or their role's)
 * 2FA policy is unmet.
 *
 * The dashboard layout returns this INSTEAD of rendering its children, so no
 * page under it ever runs — the data layer would refuse those reads anyway, and
 * a screenful of error boundaries is a worse way to say "enrol first".
 *
 * Three ways out, all of them honest: enrol (the wizard, which is the point),
 * switch to a team without the policy, or sign out.
 */
export function TwoFactorLockScreen({
  reason,
  otherTeams,
}: {
  reason: string;
  otherTeams: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [wizard, setWizard] = React.useState(false);
  const [switching, setSwitching] = React.useState(false);

  async function switchTeam(teamId: string) {
    setSwitching(true);
    const res = await gqlAction(
      `mutation ($teamId: ID!) { switchTeam(teamId: $teamId) }`,
      { teamId },
    );
    setSwitching(false);
    if (res.ok) router.refresh();
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-[var(--warning)]/10">
            <ShieldAlert className="size-5 text-[var(--warning)]" />
          </div>
          <CardTitle>Two-factor authentication required</CardTitle>
          <CardDescription>
            {reason} requires every member to have two-factor authentication.
            Turn it on to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button className="w-full" onClick={() => setWizard(true)}>
            Turn on two-factor authentication
          </Button>

          {otherTeams.length > 0 && (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-sm text-muted-foreground">
                Or switch to a team that does not require it:
              </p>
              <div className="flex flex-wrap gap-2">
                {otherTeams.map((t) => (
                  <Button
                    key={t.id}
                    variant="outline"
                    size="sm"
                    disabled={switching}
                    onClick={() => void switchTeam(t.id)}
                  >
                    {t.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-border pt-4">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={async () => {
                await gqlAction(`mutation { logout }`, {});
                router.push("/login");
                router.refresh();
              }}
            >
              Sign out
            </Button>
          </div>
        </CardContent>
      </Card>

      <TwoFactorWizard open={wizard} onOpenChange={setWizard} mandatory />
    </div>
  );
}
