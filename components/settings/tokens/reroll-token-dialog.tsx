"use client";

import * as React from "react";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { gqlAction } from "@/lib/graphql-client";
import {
  DEFAULT_TOKEN_EXPIRY,
  TOKEN_EXPIRY_CHOICES,
  expiresAtFor,
} from "@/components/settings/tokens/token-expiry";

/** Asks for a new expiry, then gives the token a new secret. */
export function RerollTokenDialog({
  tokenId,
  tokenName,
  open,
  onOpenChange,
  onRerolled,
}: {
  tokenId: string;
  tokenName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRerolled: (raw: string) => void;
}) {
  const [expiry, setExpiry] = React.useState<string>(DEFAULT_TOKEN_EXPIRY);
  const selectId = React.useId();

  return (
    <ConfirmAction
      open={open}
      onOpenChange={(next) => {
        if (next) setExpiry(DEFAULT_TOKEN_EXPIRY);
        onOpenChange(next);
      }}
      title="Reroll token?"
      description={
        <>
          <strong>{tokenName}</strong> gets a new secret. Its name, permissions
          and access stay the same.
        </>
      }
      consequence="The current secret stops working immediately, everywhere it is used."
      confirmLabel="Reroll"
      extra={
        <div className="space-y-2">
          <FieldLabel
            htmlFor={selectId}
            info="The new secret's expiry, counted from now. Rerolling an expired token brings it back."
          >
            Expires
          </FieldLabel>
          <Select value={expiry} onValueChange={setExpiry}>
            <SelectTrigger id={selectId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TOKEN_EXPIRY_CHOICES.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
      onConfirm={async () => {
        const res = await gqlAction<
          { rotateToken: { raw: string } },
          { raw: string }
        >(
          `mutation($id: String!, $expiresAt: String) { rotateToken(id: $id, expiresAt: $expiresAt) { raw } }`,
          { id: tokenId, expiresAt: expiresAtFor(expiry) },
          (d) => d.rotateToken,
        );
        if (res.ok && res.data) onRerolled(res.data.raw);
        return res;
      }}
    />
  );
}
