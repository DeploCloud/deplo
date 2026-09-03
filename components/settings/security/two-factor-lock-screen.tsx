"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TeamAvatar } from "@/components/shared/user-avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TwoFactorWizard } from "./two-factor-wizard";
import { gqlAction } from "@/lib/graphql-client";
import { DocsLink } from "@/components/ui/docs-link";

/**
 * What a member sees instead of the dashboard when a team's (or their role's) 2FA
 * policy is unmet.
 */
export function TwoFactorLockScreen({
  reason,
  otherTeams,
  hasPasskey = false,
}: {
  reason: string;
  otherTeams: {
    id: string;
    name: string;
    slug: string;
    avatarUrl: string | null;
  }[];
  /** This account holds a passkey that works here, but did not sign in with it. */
  hasPasskey?: boolean;
}) {
  const router = useRouter();
  const [wizard, setWizard] = React.useState(false);

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-[var(--warning)]/10">
            <ShieldAlert className="size-5 text-[var(--warning)]" />
          </div>
          <CardTitle>Two-factor authentication required</CardTitle>
          <CardDescription>
            {reason} requires every member to have a second factor. Add one to
            continue. <DocsLink topic="team.requireTwoFactor" />
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button className="w-full" onClick={() => setWizard(true)}>
            Turn on two-factor authentication
          </Button>
          {/**
           * The other way out of this screen (ADR-0024). Adding a passkey here unblocks the
           * CURRENT session, because registering one is a user-verified ceremony on this
           * device - so it is a way out and not just a suggestion.
           */}
          <p className="text-center text-sm text-muted-foreground">
            {hasPasskey ? (
              <>Or sign out and sign back in with your passkey.</>
            ) : (
              <>
                Or{" "}
                <Link
                  href="/settings/security"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  add a passkey
                </Link>{" "}
                - that counts too.
              </>
            )}
          </p>

          {otherTeams.length > 0 && (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-sm text-muted-foreground">
                Or switch to a team that does not require it:
              </p>
              <div className="flex flex-wrap gap-2">
                {/* A link, not a mutation: the team a page is in IS its address. */}
                {otherTeams.map((t) => (
                  <Button key={t.id} asChild variant="outline" size="sm">
                    <Link href={`/${t.slug}`}>
                      <TeamAvatar
                        name={t.name}
                        avatarUrl={t.avatarUrl}
                        size="sm"
                      />
                      {t.name}
                    </Link>
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
