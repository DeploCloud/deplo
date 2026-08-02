"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldCheck, ShieldOff } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InfoTip } from "@/components/ui/info-tip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { TwoFactorWizard } from "./two-factor-wizard";
import { authClient } from "@/lib/auth/client";

/**
 * Two-factor status and the three things you can do with it: turn it on (the
 * wizard), mint a fresh set of recovery codes, and turn it off.
 *
 * All three go through Better Auth's own endpoints rather than GraphQL — see
 * [lib/auth/client.ts](../../../lib/auth/client.ts) for why that exception exists.
 */
export function TwoFactorCard({
  enabled,
  /** Named when a team or role policy makes 2FA mandatory: disabling is refused. */
  requiredBy,
}: {
  enabled: boolean;
  requiredBy?: string | null;
}) {
  const router = useRouter();
  const [wizard, setWizard] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [codes, setCodes] = React.useState<string[] | null>(null);

  async function disable(): Promise<{ ok: true } | { ok: false; error: string }> {
    const res = await authClient.twoFactor.disable({ password });
    if (res.error)
      return { ok: false, error: res.error.message ?? "That password is not correct" };
    setPassword("");
    router.refresh();
    return { ok: true };
  }

  async function regenerate(): Promise<
    { ok: true } | { ok: false; error: string }
  > {
    const res = await authClient.twoFactor.generateBackupCodes({ password });
    if (res.error)
      return { ok: false, error: res.error.message ?? "That password is not correct" };
    setPassword("");
    setCodes(res.data.backupCodes);
    return { ok: true };
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Two-factor authentication
          <InfoTip content="A code from your phone, on top of your password. Someone who learns your password still cannot sign in." />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {enabled ? (
              <ShieldCheck className="size-5 text-[var(--success)]" />
            ) : (
              <ShieldOff className="size-5 text-muted-foreground" />
            )}
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                {enabled ? "On" : "Off"}
                {enabled && <Badge variant="secondary">Authenticator app</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">
                {enabled
                  ? "Sign-in asks for a code from your authenticator app."
                  : "Your password is the only thing protecting this account."}
              </p>
            </div>
          </div>
          {!enabled && (
            <Button onClick={() => setWizard(true)}>Turn on</Button>
          )}
        </div>

        {enabled && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <ConfirmAction
              trigger={<Button variant="outline">New recovery codes</Button>}
              title="Generate new recovery codes"
              description="Your existing recovery codes stop working immediately. The new set is shown once."
              confirmLabel="Generate"
              onConfirm={regenerate}
              confirmDisabled={!password}
              extra={
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Current password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              }
            />
            <ConfirmAction
              trigger={
                <Button variant="outline" disabled={!!requiredBy}>
                  Turn off
                </Button>
              }
              title="Turn off two-factor authentication"
              description={
                requiredBy
                  ? `${requiredBy} requires two-factor authentication, so it cannot be turned off while you are a member.`
                  : "Your account goes back to being protected by a password alone."
              }
              confirmLabel="Turn off"
              variant="destructive"
              onConfirm={disable}
              confirmDisabled={!password || !!requiredBy}
              extra={
                requiredBy ? undefined : (
                  <Input
                    type="password"
                    autoComplete="current-password"
                    placeholder="Current password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )
              }
            />
          </div>
        )}

        {codes && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-sm font-medium">Your new recovery codes</p>
            <p className="text-sm text-muted-foreground">
              Each one signs you in once. This is the only time they are shown.
            </p>
            <ul className="grid grid-cols-2 gap-2 pt-1 font-mono text-xs">
              {codes.map((c) => (
                <li key={c} className="text-center">
                  {c}
                </li>
              ))}
            </ul>
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(codes.join("\n"));
                  toast.success("Recovery codes copied");
                }}
              >
                Copy
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCodes(null)}>
                I have saved them
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <TwoFactorWizard open={wizard} onOpenChange={setWizard} />
    </Card>
  );
}
