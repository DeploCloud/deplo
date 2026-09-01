"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldCheck, ShieldOff } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InfoTip } from "@/components/ui/info-tip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { TwoFactorWizard } from "./two-factor-wizard";
import { copyText } from "@/lib/clipboard";
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
 */
export function TwoFactorCard({
  enabled,
  /** Named when a team or role policy makes 2FA mandatory: disabling is refused. */
  requiredBy,
  /**
   * Where this account's passkey stands RIGHT NOW, which is not the same question
   * as whether it owns one: - `none`: no usable passkey.
   */
  passkeyStanding = "none",
  wizardOpen,
  onWizardOpenChange,
}: {
  enabled: boolean;
  requiredBy?: string | null;
  passkeyStanding?: "none" | "idle" | "carrying";
  /** Owned by the page, so the Account protection card can open it too. */
  wizardOpen: boolean;
  onWizardOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
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
    const res = await gqlAction<
      { regenerateRecoveryCodes: string[] },
      string[]
    >(REGENERATE, { password, code }, (d) => d.regenerateRecoveryCodes);
    if (!res.ok) return res;
    setPassword("");
    setCode("");
    setCodes(res.data ?? []);
    return res;
  }

  /**
   * The password + code pair both dialogs collect.
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
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Two-factor authentication
          <InfoTip
            content="A code from your phone, on top of your password. Someone who learns your password still cannot sign in."
            docs="team.twoFactor"
          />
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
                {enabled && (
                  <Badge variant="secondary">Authenticator app</Badge>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {enabled
                  ? "Sign-in asks for a code from your authenticator app."
                  : passkeyStanding === "carrying"
                    ? "Your passkey is already your second factor. An authenticator app is a spare."
                    : passkeyStanding === "idle"
                      ? "Your passkey counts as a second factor, but this session signed in with your password."
                      : "Your password is the only thing protecting this account."}
              </p>
            </div>
          </div>
          {!enabled && (
            <Button onClick={() => onWizardOpenChange(true)}>Turn on</Button>
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
                onClick={async () => {
                  if (!(await copyText(codes.join("\n")))) return;
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

      <TwoFactorWizard open={wizardOpen} onOpenChange={onWizardOpenChange} />
    </Card>
  );
}
