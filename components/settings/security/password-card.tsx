"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InfoTip } from "@/components/ui/info-tip";
import { PasswordField } from "@/components/ui/password-field";
import { passwordMeetsPolicy } from "@/lib/password-policy";
import { gqlAction } from "@/lib/graphql-client";

const CHANGE_PASSWORD = /* GraphQL */ `
  mutation ChangePassword($currentPassword: String!, $newPassword: String!) {
    changePassword(currentPassword: $currentPassword, newPassword: $newPassword)
  }
`;

/**
 * Change the account password.
 */
export function PasswordCard({
  twoFactorEnabled,
}: {
  twoFactorEnabled: boolean;
}) {
  const [pending, startTransition] = React.useTransition();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (next !== confirm) {
      toast.error("New passwords don't match");
      return;
    }
    startTransition(async () => {
      const res = await gqlAction(CHANGE_PASSWORD, {
        currentPassword: current,
        newPassword: next,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        twoFactorEnabled
          ? "Password changed. Sign in again with the new one."
          : "Password changed. Every other device has been signed out.",
      );
      setCurrent("");
      setNext("");
      setConfirm("");
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Password
          <InfoTip
            content={
              twoFactorEnabled
                ? "Changing it signs out every device, this one included - you will be asked to sign in again."
                : "Changing it signs out every other device. This one stays signed in."
            }
            docs="team.password"
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} method="post" className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="acct-current">Current password</Label>
            <Input
              id="acct-current"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <PasswordField
              id="acct-new"
              name="newPassword"
              label="New password"
              value={next}
              onChange={setNext}
            />
            <div className="space-y-2">
              <Label htmlFor="acct-confirm">Confirm new password</Label>
              <Input
                id="acct-confirm"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={pending || !current || !passwordMeetsPolicy(next)}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
