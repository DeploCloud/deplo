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
import { gqlAction } from "@/lib/graphql-client";

const DISABLE = /* GraphQL */ `
  mutation DisableTwoFactor($password: String!, $code: String!) {
    disableTwoFactor(password: $password, code: $code)
  }
`;

const REGENERATE = /* GraphQL */ `
  mutation RegenerateRecoveryCodes($password: String!, $code: String!) {
    regenerateRecoveryCodes(password: $password, code: $code)
  }
`;

/**
 * Two-factor status and the three things you can do with it: turn it on (the
 * wizard), mint a fresh set of recovery codes, and turn it off.
 *
 * The last two ask for the password AND a live code, which is the whole point:
 * a password on its own is exactly what two-factor is there to survive, so
 * letting it switch two-factor off would make the feature protect nothing
 * against the attack it exists for. A recovery code counts as the second factor,
 * so losing the phone is not a dead end. See lib/data/two-factor.ts.
 */
export function TwoFactorCard({
  enabled,
  /** Named when a team or role policy makes 2FA mandatory: disabling is refused. */
  requiredBy,
  /**
   * A policy IS in force, and this account's passkey is what satisfies it - so
   * `requiredBy` is null and turning the app on is optional. Without saying so,
   * "Off" under a team that mandates two-factor reads as something broken.
   */
  satisfiedByPasskey = false,
}: {
  enabled: boolean;
  requiredBy?: string | null;
  satisfiedByPasskey?: boolean;
}) {
  const router = useRouter();
  const [wizard, setWizard] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [codes, setCodes] = React.useState<string[] | null>(null);

  async function disable() {
    const res = await gqlAction(DISABLE, { password, code });
    if (!res.ok) return res;
    setPassword("");
    setCode("");
    router.refresh();
    return res;
  }

  async function regenerate() {
    const res = await gqlAction<{ regenerateRecoveryCodes: string[] }, string[]>(
      REGENERATE,
      { password, code },
      (d) => d.regenerateRecoveryCodes,
    );
    if (!res.ok) return res;
    setPassword("");
    setCode("");
    setCodes(res.data ?? []);
    return res;
  }

  /**
   * The password + code pair both dialogs collect.
   *
   * One field for the code, not a TOTP/recovery toggle: a recovery code never
   * looks like six digits, so the server can tell them apart on its own, and
   * somebody reaching for one has already lost their phone and does not need to
   * find a switch first.
   */
  const stepUpFields = (
    <div className="space-y-2">
      <Input
        type="password"
        autoComplete="current-password"
        placeholder="Current password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Input
        autoComplete="one-time-code"
        inputMode="text"
        placeholder="Authenticator code, or a recovery code"
        className="font-mono"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
    </div>
  );

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
              <p className="mt-1 text-sm text-muted-foreground">
                {enabled
                  ? "Sign-in asks for a code from your authenticator app."
                  : satisfiedByPasskey
                    ? "Your passkey is already your second factor. An authenticator app is a spare, not a requirement."
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
              confirmDisabled={!password || !code.trim()}
              extra={stepUpFields}
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
              confirmDisabled={!password || !code.trim() || !!requiredBy}
              extra={requiredBy ? undefined : stepUpFields}
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
